const { expect, assert } = require('chai');
const { getRewardsAtBlock, stakingBoost } = require('../lib/blockData');
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
    let mockTokenDecimals = {
        [tokenAddress]: 18,
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
            factorUSD: '0.000000000000000045',
            feeFactor: '1',
            pool: '0xfff29c8bce4fbe8702e9fa16e0e6c551f364f420',
            balAndRatioFactor: '1',
            valueUSD: '0.000000000000000045',
            wrapFactor: '1',
        };

        assert.deepEqual(
            result[0][userAddress],
            [expectedUserPool],
            'should return user pools'
        );

        assert.deepEqual(
            result[1][userAddress].toNumber(),
            98.03921568627452,
            'should return user bal received'
        );

        assert.deepEqual(
            result[2][tokenAddress].toNumber(),
            2.295e-16,
            'should return token total market caps'
        );
    });
});

describe('stakingBoost', () => {
    it('should calculate the staking boost based on the temp boost', () => {
        let finalLiquidity = bnum(290000000);
        let liquidityPreStaking = bnum(200000000);
        let tempLiquidity = bnum(230000000);

        let expectedBoost = bnum(9);

        let result = stakingBoost(
            finalLiquidity,
            liquidityPreStaking,
            tempLiquidity
        );

        assert.equal(
            result,
            expectedBoost,
            'should compute the staking boost correctly'
        );
    });
});
