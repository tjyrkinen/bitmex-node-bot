import * as _ from 'lodash';

function env<T>(key: string, defaultValue: T) {
  return process.env[key] || defaultValue;
}

export default {
  keys: {
    bitmex: {
      id: env('KEYS_BITMEX_ID',  null),
      secret: env('KEYS_BITMEX_SECRET',  null),
      live: !!env('KEYS_BITMEX_LIVE', false)
    }
  },

  collector: {
    startTime: env('COLLECTOR_START_TIME', null)
  },

  databases: {
    history: {
      type: env('DATABASES_HISTORY_TYPE', 'influx'),
      host: env('DATABASES_HISTORY_HOST', 'influx'),
      port: Number(env('DATABASES_HISTORY_PORT', 8086)),
      name: env('DATABASES_HISTORY_NAME', 'trades'),
      nonFinalMeasurement: env('DATABASES_HISTORY_NON_FINAL_MEASUREMENT', 'trades_aggregated'),
      measurement: env('DATABASES_HISTORY_MEASUREMENT', 'trades_aggregated_1s')
    }
  },

  predictor: {
    host: env('PREDICTOR_HOST', 'predictor'),
    port: Number(env('PREDICTOR_PORT', 4242)),
    modelName: env('PREDICTOR_MODEL_NAME', 'no_model')
  },

  logs: {
    balance: env('LOGS_BALANCE', 'balance.csv'),
    tech: env('LOGS_TECH', ''),
    execution: env('LOGS_EXECUTION', ''),
    network: env('LOGS_NETWORK', ''),
    influxUrl: env('LOGS_INFLUX_URL', null),
    influxUsername: env('LOGS_INFLUX_USERNAME', null),
    influxPassword: env('LOGS_INFLUX_PASSWORD', null),
    influxDatabase: env('LOGS_INFLUX_DATABASE', 'botlogs'),
    influxExtraUrl: env('LOGS_INFLUX_EXTRA_URL', null),
    influxExtraUsername: env('LOGS_INFLUX_EXTRA_USERNAME', null),
    influxExtraPassword: env('LOGS_INFLUX_EXTRA_PASSWORD', null),
    influxExtraDatabase: env('LOGS_INFLUX_EXTRA_DATABASE', 'botlogs'),
    influxTags: _.fromPairs(_.compact(env('LOGS_INFLUX_TAGS', '').split(',')).map(pair => pair.split('=')))
  },

  bot: {
    betRatio: Number(env('BOT_BET_RATIO', 1.0)),
    orderSizingMethod: env('BOT_ORDER_SIZING_METHOD', 'A'),
    requestThrottleMinimum: Number(env('BOT_REQUEST_THROTTLE_MINIMUM', 1.5))
  }
}
