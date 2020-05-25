declare module "config" {
  export type BitMexKey = {
    id: string,
    secret: string,
    live: boolean
  };

  type DatabaseConfig = {
    type: 'influx' | 'postgres',
    host: string,
    port: number,
    name: string
  }

  export const collector: {startTime: string};

  export const keys: {[keyName: string]: BitMexKey};

  export const databases: {[purpose: string]: DatabaseConfig};

  export const predictor: {host: string, port: number};

  export const logs: {[purpose: string]: string};

  export const bot: {[key: string]: number};
}