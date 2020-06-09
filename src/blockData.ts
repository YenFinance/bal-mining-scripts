import {
    getPoolInvariantData,
    getPoolVariantData,
    poolLiquidity,
    PoolDataResult,
    PoolData,
    SkipReason,
} from './poolData';
const { scale, bnum } = require('./utils');
const { BLACKLISTED_SHAREHOLDERS } = require('./users');
import { uncappedTokens, BAL_TOKEN } from './tokens';

const TEMP_STAKING_BOOST = bnum(3);
const MARKETCAP_CAP = bnum(10000000);

import { BigNumber } from 'bignumber.js';

interface UserPoolData {
    pool: string;
    feeFactor: string;
    balAndRatioFactor: string;
    wrapFactor: string;
    valueUSD: string;
    factorUSD: string;
}

interface TokenTotalLiquidities {
    [address: string]: BigNumber;
}

export function stakingBoost(
    finalLiquidity,
    liquidityPreStaking,
    tempLiquidity,
    tempStakingBoost = TEMP_STAKING_BOOST
) {
    let desiredBoost = finalLiquidity.minus(liquidityPreStaking);
    let tempLiquidityBoost = tempLiquidity.minus(liquidityPreStaking);
    return desiredBoost.div(tempLiquidityBoost).times(tempStakingBoost);
}

function addLiquidities(tokenTotalLiquidities, poolData) {
    const {
        tokens,
        eligibleTotalWeight,
        originalPoolLiquidityFactor,
    } = poolData;
    for (const r of tokens) {
        let tokenLiquidityWithCap = r.normWeight
            .div(eligibleTotalWeight)
            .times(originalPoolLiquidityFactor);

        if (tokenTotalLiquidities[r.token]) {
            tokenTotalLiquidities[r.token] = bnum(
                tokenTotalLiquidities[r.token]
            ).plus(tokenLiquidityWithCap);
        } else {
            tokenTotalLiquidities[r.token] = tokenLiquidityWithCap;
        }
    }
    return tokenTotalLiquidities;
}

export function sumLiquidities(pools): { [address: string]: BigNumber } {
    return pools.reduce((t, poolData) => {
        return addLiquidities(t, poolData);
    }, {});
}

export async function getRewardsAtBlock(
    web3,
    blockNum,
    bal_per_snapshot,
    pools,
    prices,
    tokenDecimals,
    poolProgress
) {
    poolProgress.update(0, { task: `Block ${blockNum} Progress - Pre` });
    let block = await web3.eth.getBlock(blockNum);

    // All the pools that will be included in the calculation
    let allPoolData: PoolData[] = [];
    // multiple derivative pools per real pool that are subdivided by whether
    // they contain BAL held by non-shareholders and shareholders

    // All the pools the user was involved with in the block
    let userPools: { [userAddress: string]: UserPoolData[] } = {};

    // The total liquidity each user contributed in the block
    let userLiquidity: { [userAddress: string]: BigNumber } = {};

    // Gather data on all eligible pools
    for (const pool of pools) {
        const poolData:
            | PoolDataResult
            | SkipReason = await getPoolInvariantData(
            web3,
            prices,
            tokenDecimals,
            block,
            pool
        );
        // this should return one or two pools (Nonstaking or [Shareholder, Nonshareholder]
        poolProgress.increment(1);
        if (
            poolData.privatePool ||
            poolData.unpriceable ||
            poolData.notCreatedByBlock
        ) {
            continue;
        }

        allPoolData = allPoolData.concat(poolData.pools);
    }

    poolProgress.update(0, { task: `Block ${blockNum} Progress - Post` });

    //////////////////////////////////////////////////////////////////
    // FIRST PASS - calculate variant data with balMultiplier = 1
    //////////////////////////////////////////////////////////////////
    let firstPassPools = allPoolData.map((p) => {
        const variantFactors = getPoolVariantData(p, bnum(1.0));
        return { ...p, ...variantFactors };
    });

    // Sum the liquidity of each token from it's presence in each pool
    let tokenTotalLiquidities: TokenTotalLiquidities = sumLiquidities(
        firstPassPools
    );

    // Calculate token cap factors
    let tokenLiquidityFactors: { [address: string]: BigNumber } = {};
    for (const [tokenAddress, totalLiquidity] of Object.entries(
        tokenTotalLiquidities
    )) {
        let uncapped = uncappedTokens.includes(tokenAddress);
        if (!uncapped && totalLiquidity > MARKETCAP_CAP) {
            tokenLiquidityFactors[tokenAddress] = MARKETCAP_CAP.div(
                totalLiquidity
            );
        }
        tokenLiquidityFactors[tokenAddress] = bnum(1);
    }

    //////////////////////////////////////////////////////////////////
    // SECOND PASS
    //////////////////////////////////////////////////////////////////
    let secondPassPools = allPoolData.map((p) => {
        const variantFactors = getPoolVariantData(p, bnum(1.0));
        return { ...p, ...variantFactors };
    });

    let secondPassPoolsWithBalMultiplier = allPoolData.map((p) => {
        let balMultiplier = p.canReceiveBoost ? TEMP_STAKING_BOOST : bnum(1.0);
        const variantFactors = getPoolVariantData(p, balMultiplier);
        return { ...p, ...variantFactors };
    });

    let totalBalancerLiquidity = Object.values(
        sumLiquidities(secondPassPools)
    ).reduce((sum, liquidity) => sum.plus(liquidity), bnum(0));

    let totalBalancerLiquidityTemp = Object.values(
        sumLiquidities(secondPassPoolsWithBalMultiplier)
    ).reduce((sum, liquidity) => sum.plus(liquidity), bnum(0));

    let targetFinalLiquidity = totalBalancerLiquidity.div(
        bnum(1).minus(bnum(45000).div(bnum(145000)))
    );

    let newBalMultiplier = stakingBoost(
        targetFinalLiquidity,
        totalBalancerLiquidity,
        totalBalancerLiquidityTemp,
        TEMP_STAKING_BOOST
    );

    //////////////////////////////////////////////////////////////////
    // THIRD PASS
    //////////////////////////////////////////////////////////////////

    let finalPassPoolsWithBalMultiplier = allPoolData.map((p) => {
        let balMultiplier = p.canReceiveBoost ? newBalMultiplier : bnum(1.0);
        const variantFactors = getPoolVariantData(p, balMultiplier);
        return { ...p, ...variantFactors };
    });

    // assert that the final liquidity is gives a "boost" of 1 in the stakingBoost function when this val is passed as totalBalancerLiquidityTemp
    // targetFinalBalancerLiquidity == finalLiquidity
    let finalBalancerLiquidity = Object.values(
        sumLiquidities(finalPassPoolsWithBalMultiplier)
    ).reduce((sum, liquidity) => sum.plus(liquidity), bnum(0));

    // Adjust pool liquidity
    for (const poolData of finalPassPoolsWithBalMultiplier) {
        const { bptSupply } = poolData;

        // Aggregate an adjusted liquidity of the pool
        const finalPoolLiquidity = poolLiquidity(
            tokenTotalLiquidities,
            poolData.tokens
        );
        // calculate the final adjusted liquidity of the pool
        // adjustedLiquidity
        const finalPoolLiquidityFactor = poolData.feeFactor
            .times(poolData.balAndRatioFactor)
            .times(poolData.wrapFactor)
            .times(finalPoolLiquidity)
            .dp(18);

        // if total supply == 0, it's private
        const isPrivatePool = bptSupply.eq(bnum(0));
        if (isPrivatePool) {
            // Private pool
            const privatePool: UserPoolData = {
                pool: poolData.poolAddress,
                feeFactor: poolData.feeFactor.toString(),
                balAndRatioFactor: poolData.balAndRatioFactor.toString(),
                wrapFactor: poolData.wrapFactor.toString(),
                valueUSD: finalPoolLiquidity.toString(),
                factorUSD: finalPoolLiquidityFactor.toString(),
            };

            if (userPools[poolData.controller]) {
                userPools[poolData.controller].push(privatePool);
            } else {
                userPools[poolData.controller] = [privatePool];
            }

            // Add this pool liquidity to total user liquidity
            if (userLiquidity[poolData.controller]) {
                userLiquidity[poolData.controller] = userLiquidity[
                    poolData.controller
                ].plus(finalPoolLiquidityFactor);
            } else {
                userLiquidity[poolData.controller] = finalPoolLiquidityFactor;
            }
        } else {
            // Shared pool

            for (const i in poolData.liquidityProviders) {
                let holder = poolData.liquidityProviders[i];
                let userBalance = poolData.lpBalances[i];

                // the value of the user's share of the pool's liquidity
                let userPoolValue = userBalance
                    .div(bptSupply)
                    .times(finalPoolLiquidity)
                    .dp(18);

                let userPoolValueFactor = userBalance
                    .div(bptSupply)
                    .times(finalPoolLiquidityFactor)
                    .dp(18);

                let sharedPool: UserPoolData = {
                    pool: poolData.poolAddress,
                    feeFactor: poolData.feeFactor.toString(),
                    balAndRatioFactor: poolData.balAndRatioFactor.toString(),
                    wrapFactor: poolData.wrapFactor.toString(),
                    valueUSD: userPoolValue.toString(),
                    factorUSD: userPoolValueFactor.toString(),
                };
                if (userPools[holder]) {
                    userPools[holder].push(sharedPool);
                } else {
                    userPools[holder] = [sharedPool];
                }

                // Add this pool's liquidity to the user's total liquidity
                userLiquidity[holder] = (userLiquidity[holder] || bnum(0)).plus(
                    userPoolValueFactor
                );
            }
        }

        poolProgress.increment(1);
    }

    // Final iteration across all users to calculate their BAL tokens for this block
    let userBalReceived: { [key: string]: BigNumber } = {};
    for (const user in userLiquidity) {
        userBalReceived[user] = userLiquidity[user]
            .times(bal_per_snapshot)
            .div(finalBalancerLiquidity);
    }

    return [userPools, userBalReceived, tokenTotalLiquidities];
}
