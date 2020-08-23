const { expect, assert } = require('chai');
const { getRewardsAtBlock, getNewBalMultiplier } = require('../lib/blockData');
const { bnum } = require('../lib/utils');
const { mockWeb3, mockPrices, mockBlock, mockPool } = require('./mocks');
const cliProgress = require('cli-progress');

const mockPoolProgress = {
    update: () => {},
    increment: () => {},
};

describe('getBlockData', () => {
    let tokenAddress = mockWeb3.utils.toChecksumAddress(
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
    );
    let tokenAddress2 = mockWeb3.utils.toChecksumAddress(
        '0x1985365e9f78359a9B6AD760e32412f4a445E862'
    );
    let mockTokenDecimals = {
        [tokenAddress]: 18,
        [tokenAddress2]: 18,
    };

    it('should return a blockData object', async () => {
        let result = await getRewardsAtBlock(
            mockWeb3,
            mockBlock.number,
            bnum(1000),
            [mockPool],
            mockPrices,
            mockTokenDecimals,
            mockPoolProgress
        );
        let userAddress = '0x59a068cc4540c8b8f8ff808ed37fae06584be019';
        let expectedUserPool = {
            factorUSD: '11499.75',
            feeFactor: '1',
            pool: '0xfff29c8bce4fbe8702e9fa16e0e6c551f364f420',
            balAndRatioFactor: '1',
            valueUSD: '11499.75',
            wrapFactor: '1',
        };

        assert.deepEqual(
            result[0][userAddress],
            [expectedUserPool],
            'should return user pools'
        );

        assert.deepEqual(
            result[1][userAddress].toNumber(),
            250,
            'should return user bal received'
        );

        assert.deepEqual(
            result[2][tokenAddress].toNumber(),
            22999.5,
            'should return token total market caps'
        );
    });
});

describe('getNewBalMultiplier', () => {
    it('should calculate the staking boost based on the temp boost', () => {
        let finalLiquidity = bnum(290000000);
        let liquidityPreStaking = bnum(200000000);
        let tempLiquidity = bnum(230000000);

        let expectedBoost = 9;

        let result = getNewBalMultiplier(
            finalLiquidity,
            liquidityPreStaking,
            tempLiquidity
        );

        assert.equal(
            result.toNumber(),
            expectedBoost,
            'should compute the staking boost correctly'
        );
    });
});
