const { expect, assert } = require('chai');
const {
    getPoolInvariantData,
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
        let expectedFeeFactor = 1;
        assert.deepEqual(
            firstPool.feeFactor.toNumber(),
            expectedFeeFactor,
            'should properly construct pool data'
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
