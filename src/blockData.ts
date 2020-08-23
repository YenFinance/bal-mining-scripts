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

const TEMP_BAL_MULTIPLIER = bnum(3);
const DEFAULT_TOKEN_CAP = bnum(10000000);

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

export function getNewBalMultiplier(
    finalLiquidity,
    liquidityPreStaking,
    tempLiquidity,
    tempBalMultiplier = TEMP_BAL_MULTIPLIER
) {
    let desiredLiquidityIncrease = finalLiquidity.minus(liquidityPreStaking);
    let tempLiquidityIncrease = tempLiquidity.minus(liquidityPreStaking);

    // edge case if the liquidity was not increased (no eligible pools)
    if (tempLiquidityIncrease.toNumber() == 0) {
        return tempBalMultiplier;
    }
    return desiredLiquidityIncrease
        .div(tempLiquidityIncrease)
        .times(tempBalMultiplier);
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
            tokenTotalLiquidities[r.token] = tokenTotalLiquidities[
                r.token
            ].plus(tokenLiquidityWithCap);
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

export async function getPoolDataAtBlock(
    web3,
    blockNum,
    pools,
    prices,
    tokenDecimals,
    poolProgress
) {
    let block = await web3.eth.getBlock(blockNum);

    // All the pools that will be included in the calculation
    let allPoolData: PoolData[] = [];
    // multiple derivative pools per real pool that are subdivided by whether
    // they contain BAL held by non-shareholders and shareholders

    // Gather data on all eligible pools
    for (const pool of pools) {
        const result: PoolDataResult | SkipReason = await getPoolInvariantData(
            web3,
            prices,
            tokenDecimals,
            block,
            pool
        );
        // this should return one or two pools (Nonstaking or [Shareholder, Nonshareholder]
        poolProgress.increment(1);
        let skipReason = result as SkipReason;
        if (
            skipReason.privatePool ||
            skipReason.unpriceable ||
            skipReason.notCreatedByBlock
        ) {
            continue;
        }

        let poolData = result as PoolDataResult;

        allPoolData = allPoolData.concat(poolData.pools);
    }
    return allPoolData;
}

export function processPoolData(poolData) {
    //////////////////////////////////////////////////////////////////
    // FIRST PASS - calculate variant data with balMultiplier = 1
    //////////////////////////////////////////////////////////////////
    let firstPassPools = poolData.map((p) => {
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
        if (!uncapped && totalLiquidity > DEFAULT_TOKEN_CAP) {
            tokenLiquidityFactors[tokenAddress] = DEFAULT_TOKEN_CAP.div(
                totalLiquidity
            );
        }
        tokenLiquidityFactors[tokenAddress] = bnum(1);
    }

    //////////////////////////////////////////////////////////////////
    // SECOND PASS
    //////////////////////////////////////////////////////////////////
    let secondPassPools = poolData.map((p) => {
        const variantFactors = getPoolVariantData(p, bnum(1.0));
        return { ...p, ...variantFactors };
    });

    let secondPassPoolsWithBalMultiplier = poolData.map((p) => {
        let balMultiplier = p.canReceiveBoost ? TEMP_BAL_MULTIPLIER : bnum(1.0);
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

    let newBalMultiplier = getNewBalMultiplier(
        targetFinalLiquidity,
        totalBalancerLiquidity,
        totalBalancerLiquidityTemp,
        TEMP_BAL_MULTIPLIER
    );
    console.log('\nNEW BAL MULTIPLIER:', newBalMultiplier.toNumber(), '\n');

    //////////////////////////////////////////////////////////////////
    // FINAL PASS
    //////////////////////////////////////////////////////////////////

    let finalPoolsWithBalMultiplier = poolData.map((p) => {
        let balMultiplier = p.canReceiveBoost ? newBalMultiplier : bnum(1.0);
        const variantFactors = getPoolVariantData(p, balMultiplier);
        return { ...p, ...variantFactors };
    });
    return { tokenTotalLiquidities, finalPoolsWithBalMultiplier };
}

export function sumUserLiquidity(
    tokenTotalLiquidities,
    pools,
    bal_per_snapshot
) {
    // assert that the final liquidity is gives a "boost" of 1 in the stakingBoost function when this val is passed as totalBalancerLiquidityTemp
    // targetFinalBalancerLiquidity == finalLiquidity
    const finalBalancerLiquidity = Object.values(sumLiquidities(pools)).reduce(
        (sum, liquidity) => sum.plus(liquidity),
        bnum(0)
    );

    // All the pools the user was involved with in the block
    let userPools: { [userAddress: string]: UserPoolData[] } = {};

    // The total liquidity each user contributed in the block
    let userLiquidity: { [userAddress: string]: BigNumber } = {};

    // Adjust pool liquidity
    for (const poolData of pools) {
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

            const lp = poolData.controller;
            if (userPools[lp]) {
                userPools[lp].push(privatePool);
            } else {
                userPools[lp] = [privatePool];
            }

            // Add this pool liquidity to total user liquidity
            if (userLiquidity[lp]) {
                userLiquidity[lp] = userLiquidity[lp].plus(
                    finalPoolLiquidityFactor
                );
            } else {
                userLiquidity[lp] = finalPoolLiquidityFactor;
            }
        } else {
            // Shared pool

            for (const i in poolData.liquidityProviders) {
                let lp = poolData.liquidityProviders[i];
                let userBalance = poolData.lpBalances[i];

                // the value of the user's share of the pool's liquidity
                let lpPoolValue = userBalance
                    .div(bptSupply)
                    .times(finalPoolLiquidity)
                    .dp(18);

                let lpPoolValueFactor = userBalance
                    .div(bptSupply)
                    .times(finalPoolLiquidityFactor)
                    .dp(18);

                let sharedPool: UserPoolData = {
                    pool: poolData.poolAddress,
                    feeFactor: poolData.feeFactor.toString(),
                    balAndRatioFactor: poolData.balAndRatioFactor.toString(),
                    wrapFactor: poolData.wrapFactor.toString(),
                    valueUSD: lpPoolValue.toString(),
                    factorUSD: lpPoolValueFactor.toString(),
                };
                if (userPools[lp]) {
                    userPools[lp].push(sharedPool);
                } else {
                    userPools[lp] = [sharedPool];
                }

                // Add this pool's liquidity to the user's total liquidity
                userLiquidity[lp] = (userLiquidity[lp] || bnum(0)).plus(
                    lpPoolValueFactor
                );
            }
        }
    }

    // Final iteration across all users to calculate their BAL tokens for this block
    let userBalReceived: { [key: string]: BigNumber } = {};
    for (const user in userLiquidity) {
        userBalReceived[user] = userLiquidity[user]
            .times(bal_per_snapshot)
            .div(finalBalancerLiquidity);
    }

    return { userPools, userBalReceived };
}
