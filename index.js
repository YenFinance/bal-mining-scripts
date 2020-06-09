require('regenerator-runtime/runtime');
const Web3 = require('web3');
const cliProgress = require('cli-progress');
const { argv } = require('yargs');

const { fetchAllPools } = require('./lib/subgraph');
const poolAbi = require('./abi/BPool.json');
const tokenAbi = require('./abi/BToken.json');

const { getRewardsAtBlock } = require('./lib/blockData');
const { REP_TOKEN, REP_TOKEN_V2 } = require('./lib/tokens');
const {
    ensureDirectoryExists,
    pricesAvailable,
    readPrices,
    writePrices,
    writePools,
    writeBlockRewards,
} = require('./lib/fileService');
const { bnum, fetchWhitelist, fetchTokenPrices } = require('./lib/utils');

const ENDPOINT = process.env.ENDPOINT_URL;
//const ENDPOINT = "ws://localhost:8546"

const web3 = new Web3(new Web3.providers.WebsocketProvider(ENDPOINT));

if (!argv.startBlock || !argv.endBlock || !argv.week) {
    console.log(
        'Usage: node index.js --week 1 --startBlock 10131642 --endBlock 10156690'
    );
    process.exit();
}

// Parameters for the week's interval
const END_BLOCK = argv.endBlock; // Closest block to reference time at end of week
const START_BLOCK = argv.startBlock; // Closest block to reference time at beginning of week
const WEEK = argv.week; // Week for mining distributions. Ex: 1

// Distribution parameters
const BAL_PER_WEEK = bnum(145000);
const BLOCKS_PER_SNAPSHOT = 256;
const NUM_SNAPSHOTS = Math.ceil(
    (END_BLOCK - START_BLOCK) / BLOCKS_PER_SNAPSHOT
);
const BAL_PER_SNAPSHOT = BAL_PER_WEEK.div(bnum(NUM_SNAPSHOTS)); // Ceiling because it includes end block

(async function () {
    console.log(
        'Computing rewards for week ' +
            WEEK +
            '\n (from block ' +
            START_BLOCK +
            ' to ' +
            END_BLOCK +
            ')'
    );

    const multibar = new cliProgress.MultiBar(
        {
            clearOnComplete: false,
            format:
                '[{bar}] {percentage}% | ETA: {eta}s | {value}/{total} | {task}',
        },
        cliProgress.Presets.shades_classic
    );

    // Setup data directory
    ensureDirectoryExists(WEEK);

    // get start and end time
    let startBlockTimestamp = (await web3.eth.getBlock(START_BLOCK)).timestamp;
    let endBlockTimestamp = (await web3.eth.getBlock(END_BLOCK)).timestamp;
    console.log(
        ' (from timestamp ' +
            startBlockTimestamp +
            ' to ' +
            endBlockTimestamp +
            ')'
    );

    // fetch the pools existing at the last block
    let pools = await fetchAllPools(END_BLOCK);
    writePools(WEEK, pools);

    // gather all the decimals of the tokens in the pools
    // assuming these don't change
    let flattenedPoolTokens = pools
        .map((p) => p.tokensList)
        .reduce((flat, xs) => flat.concat(xs), []);
    let allTokensSet = new Set(flattenedPoolTokens);
    let allTokens = [...allTokensSet];
    let tokenDecimals = {};
    allTokens.forEach(async (t) => {
        let bToken = new web3.eth.Contract(tokenAbi, t);
        let decimals = await bToken.methods.decimals().call();
        tokenDecimals[web3.utils.toChecksumAddress(t)] = decimals;
    });

    // fetch the prices or read them from the file
    let prices = {};
    if (pricesAvailable(WEEK)) {
        prices = readPrices(WEEK);
    } else {
        const whitelist = await fetchWhitelist();

        let priceProgress = multibar.create(whitelist.length, 0, {
            task: 'Fetching Prices',
        });

        prices = await fetchTokenPrices(
            whitelist,
            startBlockTimestamp,
            endBlockTimestamp,
            priceProgress
        );

        prices[REP_TOKEN] = prices[REP_TOKEN_V2];

        writePrices(WEEK, prices);
    }

    const poolProgress = multibar.create(pools.length, 0, {
        task: 'Block Progress',
    });
    const blockProgress = multibar.create(NUM_SNAPSHOTS, 0, {
        task: 'Overall Progress',
    });

    // loop backwards through blocks that are spaced by a snapshot window
    let blockNums = Array.from(
        { length: NUM_SNAPSHOTS },
        (x, i) => END_BLOCK - BLOCKS_PER_SNAPSHOT * i
    );

    for (let blockNum of blockNums) {
        let shouldSkipBlock = argv.skipBlock && blockNum >= argv.skipBlock;
        if (shouldSkipBlock) {
            blockProgress.increment(1);
            continue;
        }

        let blockRewards = await getRewardsAtBlock(
            web3,
            blockNum,
            BAL_PER_SNAPSHOT,
            pools,
            prices,
            tokenDecimals,
            poolProgress
        );
        writeBlockRewards(WEEK, blockNum, blockRewards);
        blockProgress.increment(1);
    }

    poolProgress.stop();
    blockProgress.stop();
})();
