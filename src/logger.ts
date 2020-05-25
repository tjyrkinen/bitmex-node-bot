import config from './config'
import * as fs from 'fs'
import * as Influx from 'influx'
import { IPoint } from 'influx';
import _ = require('lodash');

export function writeSimpleLog(row: object, fileName: string) {
  const logFile = fileName

  if (!logFile) {
    return
  }

  fs.appendFile(logFile, [new Date().toISOString()].concat(Object.values(row)).join(',') + '\n', () => null);
}

export const logConsole = (...items: any[]) => console.log(new Date().toISOString(), ...items);

export interface InfluxOpts {
  influxUrl: string | null;
  influxUsername: string | null;
  influxPassword: string | null;
  influxDatabase: string | null;
}

export default class Logger {
  private influxClient: Influx.InfluxDB | null = null;
  private throttledLogPoints: IPoint[] = [];
  private influxThrottleTimeout: number = 14000;

  private defaultTagValues = {
    exchange: 'BMEX',
    ...config.logs.influxTags,
    model_name: config.predictor.modelName,
    predictor_name: config.predictor.host.replace(/[.:\/-]/g, '_'),
    is_live: String(config.keys.bitmex.live),
    account_id: String(config.keys.bitmex.id),
  }

  constructor(
      private opts: InfluxOpts
  ) {
    const {influxUrl, influxUsername, influxPassword, influxDatabase} = this.opts;

    if (influxUrl && influxDatabase) {
      if (!influxUsername || !influxPassword) {
        this.console('Log influx url specified but no username or password')
      }
      else {
        const {FLOAT, INTEGER, BOOLEAN} = Influx.FieldType;

        const commonTags = ['model_name', 'predictor_name', 'is_live', 'account_id', 'exchange'].concat(Object.keys(config.logs.influxTags))

        const influxSchema = [
          {
            measurement: 'balance',
            fields: {
              margin_balance: FLOAT,
              available_margin: FLOAT,
              unrealised_pnl: FLOAT,
              unrelalised_usd: FLOAT,
              realized_btc: FLOAT,
              realized_usd: FLOAT,
            },
            tags: commonTags
          },
          // {
          //   measurement: 'position',
          //   fields: {
          //     size: FLOAT,
          //     entry_price: FLOAT
          //   },
          //   tags: commonTags.concat(['symbol'])
          // },
          {
            measurement: 'network',
            fields: {
              duration: FLOAT // seconds
            },
            tags: commonTags.concat(['op', 'result'])
          },
          {
            measurement: 'instrument',
            fields: {
              last_price: FLOAT,
              mid_price: FLOAT
            },
            tags: commonTags.concat(['symbol'])
          },
          {
            measurement: 'execution',
            fields: {
              size: FLOAT,
              orderQty: FLOAT,
              lastQty: FLOAT,
              leavesQty: FLOAT,
              avgPrice: FLOAT
            },
            tags: commonTags.concat(['symbol', 'side'])
          }
        ]

        const fullInfluxUrl = `https://${influxUsername}:${influxPassword}@${influxUrl}:433/${influxDatabase}`
        this.console('Creating influx client to', fullInfluxUrl)

        this.influxClient = new Influx.InfluxDB({
          host: influxUrl,
          //username: influxUsername,
          //password: influxPassword,
          database: influxDatabase,
          protocol: 'https',
          port: 443,
          options: {
            headers: {
              'Authorization': 'Basic ' + Buffer.from(influxUsername + ':' + influxPassword).toString('base64')
            }
          }
        })
      }
    }
  }

  console = logConsole;

  file = (filename: string, data: object) => writeSimpleLog(data, filename);

  private writeInfluxPointsNoThrottle = (points: IPoint[]) => {
    if (!this.influxClient) {
      this.console('Should have written points to influx but no influx client present')
      return
    }

    return this.influxClient.writePoints(points, {precision: 'ms'})
      .catch((err) => this.console('Error writing log points to influx:', err.message))
  }

  /**
   * Writes whatever points are waiting for write. Executes only every x ms.
   */
  writeThrottledInfluxPoints = _.throttle(() => {
    const points = this.throttledLogPoints;
    this.throttledLogPoints = []

    if (points.length === 0) {
      return
    }

    this.writeInfluxPointsNoThrottle(points);
  }, this.influxThrottleTimeout, {leading: false, trailing: true})

  writeInfluxPoint = (measurement: string, data: object, tags: {[key: string]: any} = {}, timestamp?: string) => {
    if (!this.influxClient) {
      return;
    }

    // Shouldn't try to write undefined/null values
    const filteredFields = _.omitBy(data, _.isNil)
    const filteredTags = _.omitBy(tags, _.isNil)

    this.throttledLogPoints.push({
      measurement: measurement,
      fields: filteredFields,
      tags: { ...this.defaultTagValues, ...filteredTags },
      timestamp: timestamp ? Date.parse(timestamp) : new Date(),
    })

    this.writeThrottledInfluxPoints()
  }

  balance({ marginBalance, availableMargin, unrealisedPnl, realizedBtc, realizedUsd, unrealizedUsd}: {[key: string]: number | null}) {
    this.writeInfluxPoint('balance', {
      margin_balance: marginBalance,
      available_margin: availableMargin,
      unrealised_pnl: unrealisedPnl,
      unrealised_usd: unrealizedUsd,
      realized_btc: realizedBtc,
      realized_usd: realizedUsd
    })
  }

  network ({duration=null, op=null, result='ok'}) {
    this.writeInfluxPoint('network', {
      duration: duration
    }, {
      op, result
    })
  }

  execution ({price=null, orderQty=null, side=null, lastQty=null, leavesQty=null, avgPrice=null, symbol=null}) {
    this.writeInfluxPoint('execution', {
      price, orderQty, lastQty, leavesQty, avgPrice
    }, {
      side, symbol
    })
  }

  position ({price=null, size=null, symbol=null}) {
    this.writeInfluxPoint('position', {
      price, size
    }, {
      symbol
    })
  }

  instrument (symbol: string, data: any) {
    this.writeInfluxPoint('instrument', {
      last_price: data.lastPrice,
      mid_price: data.midPrice
    }, {
      symbol
    })
  }

  tech (data: any) {
    this.writeInfluxPoint('tech', _.omit(data, 'midPrice', 'lastPrice'))
  }

  customMeasurement (measurement: string, data: object, tags: object = {}) {
    this.writeInfluxPoint(measurement, data, tags)
  }
}
