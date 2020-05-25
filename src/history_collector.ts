import BitMex, {BitMexOptions} from './exchanges/bitmex';
import {Trade, TradeInfluxResult} from './exchanges/bitmex_types';
import * as _ from 'lodash';

import * as Influx from 'influx';
import * as bluebird from 'bluebird';
import * as moment from 'moment';

import config from './config';
import { IPoint } from 'influx';
import Logger, {logConsole as log, logConsole } from './logger';

const {host, port, name} = config.databases.history;
const bmKey = config.keys.bitmex;

const symbol = 'XBTUSD';
const exchange = 'BMEX';

const getAggregateQuery = (from?: string | null, to?: string | null) =>
  from
    ? (to
        ? `select last(price) as price, sum(quantity) as quantity, sum(quantity_signed) as quantity_signed, sum(value) as value, count(price) as num_ticks into ${config.databases.history.measurement} from ${config.databases.history.nonFinalMeasurement} where time >= '${from}' and time <= '${to}' group by time(1s), exchange, label, sessionId, side`
        : `select last(price) as price, sum(quantity) as quantity, sum(quantity_signed) as quantity_signed, sum(value) as value, count(price) as num_ticks into ${config.databases.history.measurement} from ${config.databases.history.nonFinalMeasurement} where time >= '${from}' group by time(1s), exchange, label, sessionId, side`
      ) 
    : `select last(price) as price, sum(quantity) as quantity, sum(quantity_signed) as quantity_signed, sum(value) as value, count(price) as num_ticks into ${config.databases.history.measurement} from ${config.databases.history.nonFinalMeasurement} group by time(1s), exchange, label, sessionId, side`

/**
 * Trades are originally written into the non-final measurement.
 * A continuous influx query writes them into the final one.
 */
async function connectHistory() : Promise<Influx.InfluxDB> {
  console.log('Connecting Influx')

  const influx =  new Influx.InfluxDB({
    host: host,
    port: port,
    database: name,
    schema: [{
      measurement: config.databases.history.nonFinalMeasurement,
      fields: {
        quantity: Influx.FieldType.FLOAT,
        quantity_signed: Influx.FieldType.FLOAT,
        price: Influx.FieldType.FLOAT,
        value: Influx.FieldType.FLOAT
      },
      tags: [
        'exchange',
        'label',
        'side',
        'sessionId'
      ]
    }]
  })

  console.log('Ensure database exists')

  await influx.createDatabase('trades').then(() => {
    console.log('Trades database existed or was created')
  })
  .catch(err => {
    console.error('Error creating history database', err)
    process.exit(1)
  })

  return influx;
}

const mergeSingleTrade = (priceAggrFn: Function) => (trades: Array<Trade>) => {
  const representative: Trade = Object.assign({}, trades[0]);
  representative.price = priceAggrFn(_.map(trades, 'price'));
  representative.size = _.sum(_.map(trades, 'size'));
  representative.grossValue = _.sum(_.map(trades, 'grossValue'));
  representative.homeNotional = _.sum(_.map(trades, 'homeNotional'));
  representative.foreignNotional = _.sum(_.map(trades, 'foreignNotional'));
  return representative;
}

function aggregateTrades(trades: Array<Trade>): Array<Trade> {
  const tradesBySide = _.groupBy(trades, 'side');
  const buysByTime = _.groupBy(tradesBySide.Buy || [], 'timestamp');
  const sellsByTime = _.groupBy(tradesBySide.Sell || [], 'timestamp');
  const mergedTrades = Object.values(buysByTime).map(mergeSingleTrade(_.max))
    .concat(Object.values(sellsByTime).map(mergeSingleTrade(_.min)));
  return mergedTrades;
}

async function run() {
  const sessionId = Date.now().toString();
  console.log(`Started history collector, sessionId: ${sessionId}`)

  const influx = await connectHistory()
  influx == influx


  if (!bmKey.id || !bmKey.secret) {
    console.error('Configuration missing for BitMex api key or secret');
    process.exit(1);
    return;
  }

  const bmOpts: BitMexOptions = {
    apiKey: bmKey.id,
    apiSecret: bmKey.secret,
    live: true,
    features: {
      trades: true
    },
    symbol: symbol
  }

  console.log('Using BitMex configuration:', bmOpts)

  const bitmexClient = new BitMex(bmOpts)


  let newTrades: Array<Trade> = [];
  let allowNewTradesWrites = false;

  let lastReceivedDataTs: number = Date.now();
  const NO_DATA_TIMEOUT = 5 * 60 * 1000;
  const NO_DATA_POLL_INTERVAL = 1000 * 30;

  setInterval(() => {
    // If no new data in x minutes, assume we have a local problem and we need to get a restart
    if (moment(lastReceivedDataTs).add(NO_DATA_TIMEOUT, 'milliseconds').isBefore(moment())) {
      logConsole(`No data received in ${NO_DATA_TIMEOUT / 1000} seconds, exiting...`);
      process.exit(1);
    }
  }, NO_DATA_POLL_INTERVAL);

  bitmexClient.on('trade', (trades: Array<Trade>) => {
    lastReceivedDataTs = Date.now();
  
    newTrades = newTrades.concat(trades);

    if (allowNewTradesWrites) {
      const thisBatch = newTrades
      newTrades = []
      writeFromRawTrades(thisBatch)
    }
  })

  bitmexClient.wsClient.on('close', () => {
    console.warn('BitMex websocket closed. Terminating fetcher in favor of a fresh start to avoid gaps in data.')
    process.exit(1)
  })

  bitmexClient.connect();

  // This is fetched from the final aggregated result on purpose
  const lastPersistedTicks = await influx.query<TradeInfluxResult>(`select * from ${config.databases.history.measurement} order by time desc limit 1`);

  console.log('last tick:', lastPersistedTicks, 'empty:', lastPersistedTicks.length == 0);
  const lastPersistedTs = lastPersistedTicks.length == 0 ? null :
    lastPersistedTicks[0].time._nanoISO || lastPersistedTicks[0].time.toNanoISOString()

  console.log('last tick ts:', lastPersistedTs);
  
  // Wait for the first trade to appear before starting fetch operations.
  // This is so we'll know when to stop and ensure we get no duplicates in the db.
  while (newTrades.length < 1) {
    await bluebird.delay(1000)
  }

  function tradeToPoint(trade: Trade): IPoint {
    return {
      tags: {
        exchange: exchange,
        label: symbol,
        side: trade.side.toUpperCase(),
        sessionId: sessionId
      },
      fields: {
        price: trade.price,
        quantity: trade.homeNotional,
        quantity_signed: trade.side === 'Buy' ? trade.homeNotional : -trade.homeNotional,
        value: trade.size
      },
      timestamp: Date.parse(trade.timestamp)
    }
  }

  function writeFromRawTrades(trades: Array<Trade>): Promise<void> {
    const aggregatedTrades = aggregateTrades(trades);
    return influx.writeMeasurement(config.databases.history.nonFinalMeasurement, aggregatedTrades.map(tradeToPoint), {
      precision: 'ms'
    })
    .then(() => {
      // Aggregate trades in the db to 1s level
      const firstTrade = aggregatedTrades[0];
      const lastTrade = aggregatedTrades[aggregatedTrades.length - 1];

      const aggregateStartTs = moment(firstTrade.timestamp).startOf('second').toISOString()
      const aggregateEndTs = moment(lastTrade.timestamp).endOf('second').toISOString()

      return influx.queryRaw(getAggregateQuery(aggregateStartTs, aggregateEndTs))
      //console.log(`Wrote ${aggregatedTrades.length} aggregated trades from ${trades[0].timestamp} to db`)
    })
    .catch(err => {
      console.error(`Error writing ${aggregatedTrades.length} aggregate trades from ${trades[0].timestamp} to db:`, err)
      process.exit(1)
    })
  }

  const startTime: string = lastPersistedTs || config.collector.startTime || '2018-01-01T00:00:00.000Z';
  const endTime = newTrades[newTrades.length - 1].timestamp;

  const fetchPageLength = 500;

  for (let page = 0,
           newFetchedTrades: Array<Trade> =[]
        ; page == 0 || newFetchedTrades.length > 0; ++page) {
    console.log(`Fetching, time range ${startTime} - ${endTime}, page ${page}`)

    newFetchedTrades = await bitmexClient.getTrades({
      startTime: startTime,
      endTime: endTime,
      start: page * fetchPageLength,
      count: fetchPageLength,
      reverse: false,
      symbol: symbol
    }, {retryCount: 500})
    .catch((err) => {
      log('Fetching trades failed and out of retries. Killing the process...', err)
      process.exit(1)
    })

    lastReceivedDataTs = Date.now();

    if (newFetchedTrades.length > 0) {
      const lastTrade = newFetchedTrades[newFetchedTrades.length - 1];
      console.log(`New trades: ${newFetchedTrades[0].timestamp} - ${lastTrade.timestamp}`)
      await writeFromRawTrades(newFetchedTrades)
      await bluebird.delay(2000) // This makes sure the rate limit will not be crossed and a bit more.
    }
  }

  console.log('Fetched all history.')

  console.log('Allowing writes of new trades into db.')
  allowNewTradesWrites = true

  // wait for first feed tick, keep collecting these
  // observable from fetch
  // observable from latest ts in database, updated by latest from fetch
  // merge, aggregate consequtive ticks (side + SAME timestamp), write
  // fetch next until ts >= first ts in feed
  // when done, write collected feed ticks empty collection
  // keep collecting from feed
  // write new feed ticks every 0.1s (/continuously?) to db


}

run()
