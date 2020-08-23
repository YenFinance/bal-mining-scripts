const { expect, assert } = require('chai');
const {
    getPoolInvariantData,
    getPoolVariantData,
    addLiquidities,
    poolLiquidity,
} = require('../lib/poolData');
const {
    mockWeb3,
    mockPrices,
    mockBlock,
    mockPool,
    mockTokenDecimals,
} = require('./mocks');
const { bnum } = require('../lib/utils');

describe('getPoolInvariantData', () => {
    it('should return a poolData object', async () => {
        let result = await getPoolInvariantData(
            mockWeb3,
            mockPrices,
            mockTokenDecimals,
            mockBlock,
            mockPool
        );
        let firstPool = result.pools[0];
        let expectedFeeFactor = 0.9999977500025312;
        assert.deepEqual(
            firstPool.feeFactor.toNumber(),
            expectedFeeFactor,
            'should properly construct pool data'
        );
    });
});

describe('getPoolVariantData', () => {
    let tokens = [
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        '0x1985365e9f78359a9b6ad760e32412f4a445e862',
    ];
    let poolData = {
        liquidity: bnum(10000),
        wrapFactor: bnum(0.9),
        feeFactor: bnum(0.9),
        tokens,
        normWeights: [bnum(0.8), bnum(0.2)],
    };
    it('should return a poolData object', async () => {
        let result = await getPoolVariantData(poolData, bnum('2.0'));
        let balAndRatioFactor = 0.64;
        let originalPoolLiquidityFactor = 5184;
        assert.equal(
            result.balAndRatioFactor.toNumber(),
            balAndRatioFactor,
            'should properly calculate bal and ratio factor'
        );
        assert.equal(
            result.originalPoolLiquidityFactor.toNumber(),
            originalPoolLiquidityFactor,
            'should properly calculate originalPoolLiquidityFactor'
        );
    });
});

let tokenTotalLiquidities = {
    0xb4efd85c19999d84251304bda99e90b92300bd93: 100,
    0x80fb784b7ed66730e8b1dbd9820afd29931aab03: 100,
};

let tokens = [
    {
        token: '0xB4EFd85c19999D84251304bDA99E90B92300Bd93',
        origLiquidity: 10,
        normWeight: 10,
    },
    {
        token: '0x80fB784B7eD66730e8b1DBd9820aFD29931aab03',
        origLiquidity: 10,
        normWeight: 10,
    },
];

describe('poolLiquidity', () => {
    it('calculates the pools adjust market cap', () => {
        let result = poolLiquidity(tokenTotalLiquidities, tokens);
        let expectedResult = 20;

        assert.equal(
            result,
            expectedResult,
            'should properly calculate the pools market cap'
        );
    });
});
