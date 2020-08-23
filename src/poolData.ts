const poolAbi = require('../abi/BPool.json');
const { bnum, scale } = require('./utils');
import { uncappedTokens, BAL_TOKEN } from './tokens';
import { BLACKLISTED_SHAREHOLDERS } from './users';
import BigNumber from 'bignumber.js';

const DEFAULT_TOKEN_CAP = bnum(10000000);

const {
    getFeeFactor,
    getBalFactor,
    getBalAndRatioFactor,
    getWrapFactor,
} = require('./factors');

BigNumber.config({
    EXPONENTIAL_AT: [-100, 100],
    ROUNDING_MODE: BigNumber.ROUND_DOWN,
    DECIMAL_PLACES: 18,
});

function atLeastTwoTokensHavePrice(tokens, prices): boolean {
    let nTokensHavePrice = 0;
    for (const token of tokens) {
        if (prices[token] !== undefined && prices[token].length > 0) {
            nTokensHavePrice++;
            if (nTokensHavePrice > 1) {
                return true;
            }
        }
    }
    return false;
}

function poolCreatedByBlock(pool, block): boolean {
    return pool.createTime < block.timestamp && pool.tokensList;
}

function closestPrice(token, timestamp, prices): BigNumber {
    let price = prices[token].reduce((a, b) => {
        return Math.abs(b[0] - timestamp * 1000) <
            Math.abs(a[0] - timestamp * 1000)
            ? b
            : a;
    })[1];
    return bnum(price);
}

interface TokenData {
    token: string;
    origLiquidity: BigNumber;
    normWeight: BigNumber;
}

async function tokenMetrics(
    bPool,
    tokens,
    tokenDecimals,
    prices,
    block
): Promise<TokenData[]> {
    let tokenData: any[] = [];

    for (const token of tokens) {
        // Skip token if it doesn't have a price
        if (prices[token] === undefined || prices[token].length === 0) {
            continue;
        }
        let bTokenDecimals = tokenDecimals[token];

        let tokenBalanceWei = await bPool.methods
            .getBalance(token)
            .call(undefined, block.number);

        let normWeight = await bPool.methods
            .getNormalizedWeight(token)
            .call(undefined, block.number);

        // may be null if no tokens have been added
        let tokenBalance = scale(tokenBalanceWei || 0, -bTokenDecimals);
        let price = bnum(closestPrice(token, block.timestamp, prices));

        let origLiquidity = tokenBalance.times(price).dp(18);

        tokenData.push({
            token,
            origLiquidity,
            price,
            normWeight: scale(normWeight, -18),
        });
    }

    return tokenData;
}

export interface PoolDataBase {
    poolAddress: string;
    tokens: any[];
    liquidity: BigNumber;
    eligibleTotalWeight: BigNumber;
    wrapFactor: BigNumber;
    bptSupply: BigNumber;
    feeFactor: BigNumber;
    liquidityProviders: string[];
    lpBalances: BigNumber[];
    controller: string;
}

interface NonstakingPool extends PoolDataBase {
    // has no pairs between BAL and an uncapped token
    canReceiveBoost: boolean;
}

interface ShareholderPool extends PoolDataBase {
    // contains pairs between BAL and uncapped tokens with exclusively shareholders
    canReceiveBoost: boolean;
}

interface NonshareholderPool extends PoolDataBase {
    // contains pairs between BAL and uncapped tokens with exclusively nonshareholders
    canReceiveBoost: boolean;
}

export interface SkipReason {
    privatePool?: boolean;
    unpriceable?: boolean;
    notCreatedByBlock?: boolean;
}

export type PoolData = NonstakingPool | NonshareholderPool | ShareholderPool;

interface PoolFromSubgraph {
    id: string;
    createTime: number;
    controller: string;
    publicSwap: boolean;
    tokensList: string[];
    shareHolders: string[];
}

// THis method should return either [[allLPs]] or [[nonshareholders], [liquidityProviders]] depending on whether the pool needs to be split or not
function splitLiquidityProviders(
    pool,
    poolTokens
): [string[]] | [string[], string[]] {
    let includesBal: boolean = poolTokens.includes(BAL_TOKEN);
    let includesUncappedTokenPair: boolean = poolTokens.reduce(
        (found, token) => {
            return (
                found || (token !== BAL_TOKEN && uncappedTokens.includes(token))
            );
        },
        false
    );
    const poolLiquidityProviders: string[] = pool.shareHolders;

    if (includesBal && includesUncappedTokenPair) {
        const shareholderBlacklist = new Set(BLACKLISTED_SHAREHOLDERS);

        let shareHolderLiquidityProviders: string[] = poolLiquidityProviders.filter(
            (lp) => shareholderBlacklist.has(lp)
        );
        let nonshareholderLiquidityProviders: string[] = poolLiquidityProviders.filter(
            (lp) => !shareholderBlacklist.has(lp)
        );

        if (
            shareHolderLiquidityProviders.length > 0 &&
            nonshareholderLiquidityProviders.length > 0
        ) {
            return [
                nonshareholderLiquidityProviders,
                shareHolderLiquidityProviders,
            ];
        }
    }
    return [poolLiquidityProviders];
}

export interface PoolDataResult {
    pools: PoolData[];
}

export function getPoolBalances(
    bPool,
    blockNum,
    liquidityProviders
): Promise<BigNumber[]> {
    return Promise.all(
        liquidityProviders.map(async (lp) => {
            let userBalanceWei = await bPool.methods
                .balanceOf(lp)
                .call(undefined, blockNum);
            let userBalance = scale(userBalanceWei, -18);
            return userBalance;
        })
    );
}

export async function getPoolInvariantData(
    web3,
    prices,
    tokenDecimals,
    block,
    pool: PoolFromSubgraph
): Promise<PoolDataResult | SkipReason> {
    if (!poolCreatedByBlock(pool, block)) {
        return { notCreatedByBlock: true };
    }

    const bPool = new web3.eth.Contract(poolAbi, pool.id);

    const publicSwap = await bPool.methods
        .isPublicSwap()
        .call(undefined, block.number);

    if (!publicSwap) {
        return { privatePool: true };
    }

    const currentTokens = await bPool.methods
        .getCurrentTokens()
        .call(undefined, block.number);

    let bptSupplyWei = await bPool.methods
        .totalSupply()
        .call(undefined, block.number);

    let bptSupply: BigNumber = scale(bptSupplyWei, -18);

    const poolTokens: string[] = currentTokens.map(
        web3.utils.toChecksumAddress
    );

    // If the pool is unpriceable, we cannot calculate any rewards
    if (!atLeastTwoTokensHavePrice(poolTokens, prices)) {
        return { unpriceable: true };
    }

    // determine if the pool should be split up
    // based on pool and lp composition and get the balances of the providers in
    // the pool
    const subpoolLiquidityProviders:
        | [string[]]
        | [string[], string[]] = splitLiquidityProviders(pool, poolTokens);
    const subpoolBalances: BigNumber[][] = await Promise.all(
        subpoolLiquidityProviders.map((lps: string[]) =>
            getPoolBalances(bPool, block.number, lps)
        )
    );
    const subpoolTotalBalances = subpoolBalances.map((spBals) =>
        spBals.reduce((sum, bal) => sum.plus(bal), bnum(0))
    );

    const subpoolWeights = subpoolTotalBalances.map(
        (totalBal) =>
            bptSupplyWei > 0
                ? totalBal.div(bptSupply)
                : bnum(1).div(subpoolLiquidityProviders.length) // if bptSupply is 0 in the case of a private pool, sum to 1
    );

    // calculate these values for both subpools if relevant
    const tokenData = await tokenMetrics(
        bPool,
        poolTokens,
        tokenDecimals,
        prices,
        block
    );

    const originalPoolLiquidity = tokenData.reduce(
        (a, t) => a.plus(t.origLiquidity),
        bnum(0)
    );

    const eligibleTotalWeight = tokenData.reduce(
        (a, t) => a.plus(t.normWeight),
        bnum(0)
    );

    const normWeights = tokenData.map((t) => t.normWeight);
    const wrapFactor = getWrapFactor(poolTokens, normWeights);

    let poolFee = await bPool.methods
        .getSwapFee()
        .call(undefined, block.number);
    poolFee = scale(poolFee, -16); // -16 = -18 * 100 since it's in percentage terms
    const feeFactor = bnum(getFeeFactor(poolFee));

    let commonFactors = {
        poolAddress: pool.id,
        controller: pool.controller,
        tokens: tokenData,
        wrapFactor,
        feeFactor,
        eligibleTotalWeight,
        normWeights,
        bptSupply,
    };
    if (subpoolLiquidityProviders.length == 1) {
        // single pool

        let lpBalances = subpoolBalances[0];
        let nonstakingPool: NonstakingPool = {
            ...commonFactors,
            canReceiveBoost: false,
            liquidityProviders: pool.shareHolders,
            liquidity: originalPoolLiquidity,
            eligibleTotalWeight,
            lpBalances,
        };
        return { pools: [nonstakingPool] };
    } else {
        // split into subpools
        let pools: (ShareholderPool | NonshareholderPool)[] = [];

        let hasNonshareholderPool: boolean =
            subpoolLiquidityProviders[0].length > 0;
        if (hasNonshareholderPool) {
            pools.push({
                ...commonFactors,
                canReceiveBoost: true,
                liquidityProviders: subpoolLiquidityProviders[0],
                lpBalances: subpoolBalances[0],
                liquidity: originalPoolLiquidity.times(subpoolWeights[0]),
            });
        }

        let hasShareholderPool: boolean =
            subpoolLiquidityProviders[1].length > 0;
        if (hasShareholderPool) {
            pools.push({
                ...commonFactors,
                canReceiveBoost: false,
                liquidityProviders: subpoolLiquidityProviders[1],
                lpBalances: subpoolBalances[1],
                liquidity: originalPoolLiquidity.times(subpoolWeights[1]),
            });
        }

        return { pools };
    }
}

interface PoolVariantFactors {
    balAndRatioFactor: number;
    originalPoolLiquidityFactor: number;
}

export function getPoolVariantData(
    poolData,
    balMultiplier
): PoolVariantFactors {
    const { liquidity, wrapFactor, feeFactor, tokens, normWeights } = poolData;

    const balAndRatioFactor = getBalAndRatioFactor(
        tokens,
        normWeights,
        balMultiplier
    );

    const originalPoolLiquidityFactor = feeFactor
        .times(balAndRatioFactor)
        .times(wrapFactor)
        .times(liquidity)
        .dp(18);

    return {
        balAndRatioFactor,
        originalPoolLiquidityFactor,
    };
}

export function poolLiquidity(tokenTotalLiquiditys, tokens): BigNumber {
    return tokens.reduce((aggregateAdjustedLiquidity, t) => {
        let adjustedTokenLiquidity;
        const shouldAdjustLiquidity =
            !uncappedTokens.includes(t.token) &&
            bnum(tokenTotalLiquiditys[t.token] || 0).isGreaterThan(
                DEFAULT_TOKEN_CAP
            );
        // if the token is capped then we scale it's adjusted market cap
        // down to the cap
        if (shouldAdjustLiquidity) {
            let tokenLiquidityFactor = DEFAULT_TOKEN_CAP.div(
                tokenTotalLiquiditys[t.token]
            );
            adjustedTokenLiquidity = t.origLiquidity
                .times(tokenLiquidityFactor)
                .dp(18);
        } else {
            adjustedTokenLiquidity = t.origLiquidity;
        }
        return aggregateAdjustedLiquidity.plus(adjustedTokenLiquidity);
    }, bnum(0));
}
