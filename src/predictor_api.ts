import * as zerorpc from 'zerorpc';
import { logConsole as log} from './logger';

export enum PredictorStatusCode {
  OK = 'ok',
  NOT_READY = 'not_ready',
  ERROR = 'error',
  NOT_FOUND = 'not_found'
}

export interface RPCSuccessResponse {
  readonly status: PredictorStatusCode.OK;
  readonly data?: any;
}

export interface RPCErrorResponse {
  readonly status: PredictorStatusCode.ERROR;
  readonly error?: string;
}

export interface RPCNotReadyResponse {
  readonly status: PredictorStatusCode.NOT_READY;
  readonly error?: string;
}

export type RPCResponse = RPCSuccessResponse | RPCErrorResponse | RPCNotReadyResponse


export interface PredictorSuccess {
  readonly status: PredictorStatusCode.OK;
}

export interface PredictorNotReady {
  readonly status: PredictorStatusCode.NOT_READY;
}

export interface PredictorError {
  readonly status: PredictorStatusCode.ERROR;
  readonly error: string;
}

export type PredictionRow = Array<number>;

export interface PredictorPrediction {
  readonly status: PredictorStatusCode;
  readonly predictions: Array<PredictionRow>;
}

export type PredictorResult = PredictorSuccess | PredictorError | PredictorNotReady

export enum PredictorRPCMethods {
  LOAD_MODEL = 'load_model',
  PREDICT = 'predict'
}

export interface Prediction2o {
  // Control both sides at the same time.
  readonly stepSize?: number;
  readonly stepExponential?: number;
  readonly maxPosition?: number;
  readonly orderSizeScale?: number;
  readonly targetPosition?: number;
  readonly maxOrdersPerSide?: number;

  // Control sides individually. If the shared value is also present, these should take precedence.
  readonly stepSizeAsk?: number;
  readonly stepSizeBid?: number;
  readonly maxPositionShort?: number;
  readonly maxPositionLong?: number;
  readonly orderSizeScaleAsk?: number;
  readonly orderSizeScaleBid?: number;
}

export interface Predictions {
  readonly predictions: Prediction2o;
  readonly dataStart: string;
  readonly dataEnd: string;
}

export class NotReadyError extends Error {
  private status: PredictorStatusCode = PredictorStatusCode.NOT_READY;
}

export class UninitializedError extends Error {
  private status: PredictorStatusCode = PredictorStatusCode.NOT_READY;
}

export default class PredictorApi {
  private rpcClient: zerorpc.Client;
  
  constructor(host: string, port: number) {
    log(`Connecting PredictorApi to ${host}:${port}`)
    this.rpcClient = new zerorpc.Client()
    this.rpcClient.connect(`tcp://${host}:${port}`);
  }

  loadModel(modelName: string): Promise<PredictorResult> {
    return new Promise((resolve, reject) => {
      this.rpcClient.invoke(PredictorRPCMethods.LOAD_MODEL, modelName, (err, result: PredictorResult) => {
        if (err) {
          reject(err)
        }
        else if (result.status == PredictorStatusCode.ERROR) {
          reject(new Error(result.error))
        }
        else {
          resolve(result)
        }
      })
    })
  }

  predictLatest(modelName: string): Promise<Predictions> {
    return new Promise((resolve, reject) => {
      this.rpcClient.invoke(PredictorRPCMethods.PREDICT, modelName, (err, result: RPCResponse) => {
        if (err) {
          reject(err)
        }
        else if (result.status === PredictorStatusCode.ERROR) {
          reject(new Error(result.error))
        }
        else if (result.status === PredictorStatusCode.NOT_READY) {
          reject(new NotReadyError('Predictor not ready'))
        }
        else {
          if (!result.data) {
            return reject(new Error('Predictor result was OK but did not return data'))
          }
          resolve(result.data as Predictions)
        }
      })
    })
  }
}