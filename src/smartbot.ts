import * as bluebird from 'bluebird';
import PredictorApi, { PredictorStatusCode, PredictionRow, NotReadyError, UninitializedError, Prediction2o } from './predictor_api';
import Logger from './logger';
import * as fs from 'fs';
import BitMexExchange, { BitMexOptions } from './exchanges/bitmex';
import * as _ from 'lodash';
import * as moment from 'moment';
import * as R from 'ramda';

import config from './config';
import { Position, Order, ActionType, Quote, Margin, Execution, SubmittedOrder, TradeSide, Trade, ExecInst, OrderRejectionReason, SubmittedAsk, SubmittedBid } from './exchanges/bitmex_types';
import { EventEmitter } from 'events';

export type BitmexEnv = 'live' | 'testnet';

const logger = new Logger({
  influxUrl: config.logs.influxUrl,
  influxUsername: config.logs.influxUsername,
  influxPassword: config.logs.influxPassword,
  influxDatabase: config.logs.influxDatabase
})

const extraLogger: Logger | null = !config.logs.influxExtraUrl ? null : new Logger({
  influxUrl: config.logs.influxExtraUrl,
  influxUsername: config.logs.influxExtraUsername,
  influxPassword: config.logs.influxExtraPassword,
  influxDatabase: config.logs.influxExtraDatabase
})

const log = logger.console;

const allLoggerInstances: Array<Logger | null> = [logger, extraLogger];

export interface SmartbotOpts {
  readonly live: boolean;
  readonly apiKey: string;
  readonly apiSecret: string;

  readonly predictionInterval: number; // ms
  readonly predictionNotReadyDelay: number; // ms

  readonly predictorHost: string;
  readonly predictorPort: number;

  readonly predictorModelName: string;
}

function writeTechLog(row: object) {
  logger.file(config.logs.tech, row)
  logger.tech(row)
  logger.instrument(symbol, _.pick(row, 'lastPrice', 'midPrice'))
}

function writeExecutionLog(row: object) {
  logger.file(config.logs.execution, row)
  logger.execution(row)
}

function writeNetworkLog(row: object) {
  logger.file(config.logs.network, row)
  logger.network(row)
}

export const SMARTBOT_DEFAULT_OPTS: SmartbotOpts = {
  live: config.keys.bitmex.live,
  apiKey: config.keys.bitmex.id || '',
  apiSecret: config.keys.bitmex.secret || '',

  predictionInterval: 1000,
  predictionNotReadyDelay: 4000,

  predictorHost: config.predictor.host,
  predictorPort: config.predictor.port,

  predictorModelName: config.predictor.modelName || '13xi_1o_symm'
}

interface NumberSettingsMap {
  [key: string]: number
}

export interface GridSettings extends NumberSettingsMap {
  stepSizeAsk: number;
  stepSizeBid: number;
  stepExponential: number;
  maxPositionShort: number;
  maxPositionLong: number;
  maxOrdersPerSide: number;
  targetPosition: number;
  orderSizeScaleAsk: number;
  orderSizeScaleBid: number;
}

const defaultGridSettings: GridSettings = {
  stepSizeAsk: 0.003,
  stepSizeBid: 0.003,
  stepExponential: 1.7,
  maxPositionShort: 10,
  maxPositionLong: 10,
  maxOrdersPerSide: 3,
  targetPosition: 0.0,
  orderSizeScaleAsk: 1,
  orderSizeScaleBid: 1
}

const symbol = 'XBTUSD';

const getDefaultGridSettings = () => Object.assign({}, defaultGridSettings);

type OrderStateType = 'synced' | 'amending' | 'deleting' | 'posting' | null

interface OrderState {
  clOrdID: string;
  status: OrderStateType;
  completion: Promise<void> | null; // If an async action is underway, this promise will resolve on completion.
}

const isDeadOrder = (order: Order) => order.ordStatus === 'Filled' || order.ordStatus === 'Canceled';

export interface OrderWish {
  readonly clOrdID?: string // May define the id for a wish if the client wants to refer to individual wishes
  readonly price: number,
  readonly orderQty: number,
  readonly side: TradeSide,
  readonly execInst: ExecInst
}

export class OrderSync {
  private currentWishes: OrderWish[] = []
  private currentOrders: {[clOrdID: string]: SubmittedOrder} = {}
  private orderStates: {[clOrdID: string]: OrderState} = {}
  private firstOrdersFetched = false;
  private emitter: EventEmitter = new EventEmitter()
  private retryOrderAdjust = _.throttle(this.adjustOrdersToWish, 500, { leading: false, trailing: true });
  public currentQuote: Quote | null = null;
  public hasAmendFailed: boolean = false;

  private flushOrdersEvery: number = 15 * 60 * 1000;
  private flushOrdersInterval: NodeJS.Timer;
  
  constructor(
    private bitmexClient: BitMexExchange,
    private priceTolerance: number, // pct how much price can differ and cause no immediate sync requirements
    private orderQtyTolerance: number // pct how much orderQty can differ and cause no immediate sync requirements
  ) {
    this.bitmexClient.subscribe('order', this.onOrder);
    this.bitmexClient.subscribe(`quote:${symbol}`, this.onQuote);
    //this.bitmexClient.subscribe('margin', this.onMargin);
    //this.bitmexClient.subscribe('position', this.onPosition);
    this.bitmexClient.subscribe(`execution:${symbol}`, this.onExecution);
    this.bitmexClient.subscribe(`trade:${symbol}`, this.onTrade);

    // Periodically delete all orders and clear local cache to ensure potential malfunctions won't totally cripple the bot indefinitely
    this.flushOrdersInterval = setInterval(this.flushOrders, this.flushOrdersEvery)
  }

  flushOrders: () => void = () => {
    this.currentOrders = {}
    this.orderStates = {}
    this.bitmexClient.deleteAllOrders()
  }

  onOrder = (orders: SubmittedOrder[], actionType: ActionType) => {
    //log('onOrder', orders.length)
    this.mapSyncOrdersTo(orders, actionType)
  }
  
  onQuote = ([quote]: Quote[]) => {
    //log('onQuote')
    this.currentQuote = Object.assign(this.currentQuote || {}, quote);
  }
  
  onExecution = (executions: Execution[]) => {
    //log('onExecution')
    executions.forEach(execution => {
      if (execution.ordStatus === 'Filled' && execution.leavesQty === 0 && execution.symbol == symbol) {
        //log(`Filled: ${execution.side} ${execution.orderQty} @ ${execution.price}`)
        this.mapDeleteOrder(execution.clOrdID);
      }
      else if (execution.ordStatus === 'Canceled') {
        //log('Order cancelled:', execution.side, execution.orderQty, execution.price, execution.ordRejReason, execution.text)
        this.mapDeleteOrder(execution.clOrdID)
      }
    })
  }
  
  onTrade = (trades: Trade[]) => {
    //log('onTrade')
    trades.forEach(trade => {
      // Trade event comes before orderbook updates, use this to update known quotes
      if (this.currentQuote) {
        this.currentQuote.askPrice = Math.max(this.currentQuote.askPrice, trade.price)
        this.currentQuote.bidPrice = Math.min(this.currentQuote.bidPrice, trade.price)
      }
    })
  }

  // private postOrders: (a: Array<{ side: TradeSide, price: number }>) => Promise<SubmittedOrder[]> = (orderDefs) => {
  //   const orders: SubmittedOrder[] = orderDefs.map(od =>
  //     this.bitmexClient.buildOrder(od.price, od.side, this.getOrderSizeNeutral())
  //   )

  //   const resultP = this.bitmexClient.postOrders(orders)
  //     .then((resultOrders: SubmittedOrder[]) => {
  //       log(`Posted ${orders.length} orders`)
  //       resultOrders.forEach(order => {
  //         this.mapUpsertOrder(order, 'synced', null);
  //       })
  //       return resultOrders
  //     })
  //     .catch(err => {
  //       log(`Failed posting ${orders.length} orders`)
  //       orders.forEach(order => {
  //         this.mapDeleteOrder(order.clOrdID);
  //       })
  //       return []
  //     })

  //   orders.forEach(o => this.mapUpsertOrder(o, 'posting', resultP))
  //   return resultP
  // }

  private getCurrentOrders: () => SubmittedOrder[] = () =>
    Object.values(this.currentOrders)

  /**
   * All orders which are not marked for deletion. Also counts orders which are in posting state but not yet accepted by the exchange.
   */
  private getActiveOrders: () => SubmittedOrder[] = () =>
    this.getCurrentOrders().filter(o => {
      const status = (this.orderStates[o.clOrdID] as OrderState).status
      return status !== 'deleting'
    })

  public updateWishes(wishes: OrderWish[]) {
    this.currentWishes = wishes
    this.adjustOrdersToWish()
  }

  public getAsks: () => SubmittedAsk[] = () =>
    this.getCurrentOrders().filter(o => o.side === 'Sell') as SubmittedAsk[]

  public getBids: () => SubmittedBid[] = () =>
    this.getCurrentOrders().filter(o => o.side === 'Buy') as SubmittedBid[]

  public getAskCount: () => number = () =>
    this.getAsks().length

  public getBidCount: () => number = () =>
    this.getBids().length

  onFill(handler: (filledOrder: SubmittedOrder) => void) {
    this.emitter.on('fill', handler);
  }

  // Sync our local book from fresh data
  private mapSyncOrdersTo = (orders: SubmittedOrder[], syncType: ActionType) => {
    orders.forEach(order => {
      if (syncType === 'delete' || isDeadOrder(order)) {
        this.mapDeleteOrder(order.clOrdID)
      }
      else {
        this.mapUpsertOrder(order)
      }
    })
  }

  private mapUpsertOrder = (order: SubmittedOrder, orderStatus: OrderStateType = 'synced', completion: Promise<any> | null = null) => {
    if (order.ordStatus === 'Filled' || order.ordStatus === 'Canceled') {
      this.mapDeleteOrder(order.clOrdID)
    }
    else {
      this.currentOrders[order.clOrdID] = Object.assign({},
        this.currentOrders[order.clOrdID], order)
  
      this.orderStates[order.clOrdID] = {
        clOrdID: order.clOrdID,
        status: orderStatus,
        completion: completion
      }
    }
  }

  private mapDeleteOrder(clOrdID: string) {
    delete this.currentOrders[clOrdID];
    delete this.orderStates[clOrdID];
  }

  async syncFromExchange() {
    const orders = await this.bitmexClient.getOrders({filter: {open: true}, reverse: true})
    this.mapSyncOrdersTo(orders, 'update')
    this.firstOrdersFetched = true
  }

  async refreshOrdersFromExchange() {
    // Fetch the past (100) orders with any state, this should also return filled & cancelled orders so we can get rid of dead ones
    const orders = await this.bitmexClient.getOrders({filter: {}, reverse: true, count: 250})
    this.mapSyncOrdersTo(orders, 'update')
    this.firstOrdersFetched = true
  }

  private adjustOrdersToWish() {
    const currentOrders = Object.values(this.currentOrders)

    // Includes orders in 'posting' state so that we don't try to create them multiple times. sendAmendOrders will filter out posting state orders before sending to exchange.
    const activeOrders = this.getActiveOrders()

    const askSorter = (o: {price: number}) => o.price
    const bidSorter = (o: {price: number}) => -o.price

    const pairWishesAndOrders = (current: SubmittedOrder[], wishes: OrderWish[]) => {
      const sharedCount = Math.min(current.length, wishes.length)
      return {
        amendCurrent: current.slice(0, sharedCount),
        amendWishes: wishes.slice(0, sharedCount),
        excess: current.slice(sharedCount),
        missing: wishes.slice(sharedCount)
      }
    }

    /**
     * Mutates incoming orders in place
     * TODO: skip orders that are already close enough to wish
     */
    const updateOrdersFrom = (orders: SubmittedOrder[], wishes: OrderWish[]) => {
      orders.forEach((order, i) => {
        order.price = wishes[i].price
        order.orderQty = wishes[i].orderQty
      })
    }

    const activeAsks = _.sortBy(activeOrders.filter(o => o.side == 'Sell'), askSorter) as SubmittedAsk[]
    const activeBids = _.sortBy(activeOrders.filter(o => o.side == 'Buy'), bidSorter) as SubmittedBid[]

    const wishesBySide = _.groupBy(this.currentWishes, 'side')
    const askWishes = _.sortBy(wishesBySide['Sell'], askSorter)
    const bidWishes = _.sortBy(wishesBySide['Buy'], bidSorter)

    const pairedAsks = pairWishesAndOrders(activeAsks, askWishes)
    const pairedBids = pairWishesAndOrders(activeBids, bidWishes)

    updateOrdersFrom(pairedAsks.amendCurrent, pairedAsks.amendWishes)
    updateOrdersFrom(pairedBids.amendCurrent, pairedBids.amendWishes)

    this.sendCreateOrders(pairedAsks.missing.concat(pairedBids.missing))
    this.sendDeleteOrders(pairedAsks.excess.concat(pairedBids.excess))
    this.sendAmendOrders(pairedAsks.amendCurrent.concat(pairedBids.amendCurrent))
  }

  markOrderState: (order: SubmittedOrder, newState: OrderStateType, completion: Promise<any> | null) => void = (order, newState, completion=null) => {
    this.orderStates[order.clOrdID] = {
      clOrdID: order.clOrdID,
      status: newState,
      completion: completion
    };
  }

  wishToOrder: (wish: OrderWish) => SubmittedOrder = (wish) => ({
    price: wish.price,
    orderQty: wish.orderQty,
    side: wish.side,
    clOrdID: this.bitmexClient.getNextClOrdID(),
    symbol: symbol,
    ordType: 'Limit',
    execInst: wish.execInst,
  })

  getOrderStatus(order: SubmittedOrder): OrderStateType {
    const state = this.orderStates[order.clOrdID]
    return state ? state.status : null
  }

  sendAmendOrders(orders: SubmittedOrder[]): Promise<void> {
    this.hasAmendFailed = false;

    // We've accepted 'posting' orders as legit for amends but don't want to really try and amend them before we know they went through. Otherwise a missing order could make the whole batch fail.
    orders = orders.filter(order => this.getOrderStatus(order) !== 'posting')

    if (orders.length === 0) {
      return Promise.resolve()
    }

    const startTime = Date.now()
    const completion = this.bitmexClient.amendOrders(orders, 1, true)
      .then(() => {
        writeNetworkLog({ duration: (Date.now() - startTime) / 1000, op: 'amend', result: 'ok' })
      })
      .catch((err) => {
        // Retry by letting the next round through faster
        this.hasAmendFailed = true
        const reason = this.bitmexClient.getErrorReason(err)
        log('Order amend failed:', err.message)

        // If there was a problem with an ordStatus, it hints that our order cache may have outdated information
        if (/ordStatus/.test(err.message)) {
          writeNetworkLog({ duration: (Date.now() - startTime) / 1000, op: 'amend', result: 'ok' })
          log('Invalid ordStatus, refreshing orders')
          this.refreshOrdersFromExchange()
        } // Same with orderID error
        else if (/Invalid orderID/.test(err.message)) {
          writeNetworkLog({ duration: (Date.now() - startTime) / 1000, op: 'amend', result: 'ok' })
          log('Invalid orderID, refreshing orders')
          this.refreshOrdersFromExchange()
        }
        else {
          writeNetworkLog({ duration: (Date.now() - startTime) / 1000, op: 'amend', result: 'error' })
        }
        // Retry but only if this call is the latest amend call
        // if (_.every(orders, (order) => {
        //   const state = this.orderStates[order.clOrdID]
        //   return !state || state.completion === completion
        // })) {
        //   this.retryOrderAdjust()
        // }
      })
    orders.forEach(o => this.mapUpsertOrder(o, 'amending', completion))
    return completion
  }

  sendDeleteOrders(orders: SubmittedOrder[]): Promise<void> {
    if (orders.length === 0) {
      return Promise.resolve()
    }

    const startTime = Date.now()
    const completion = this.bitmexClient.deleteOrders(orders.filter(o => o.orderID !== undefined).map(o => o.orderID as string), 1)
      .then(() => {
        writeNetworkLog({ duration: (Date.now() - startTime) / 1000, op: 'delete', result: 'ok' })
      })
      .catch((err) => {
        log('Order delete failed:', err.message)
        writeNetworkLog({ duration: (Date.now() - startTime) / 1000, op: 'delete', result: 'error' })
        // Retry but only if this call is the latest delete call
        if (_.every(orders, (order) => {
          const state = this.orderStates[order.clOrdID]
          return !state || state.completion === completion
        })) {
          orders.forEach(o => this.markOrderState(o, 'synced', completion))
          this.retryOrderAdjust()
        }
      })
    orders.forEach(o => this.markOrderState(o, 'deleting', completion))
    return completion
  }

  sendCreateOrders(wishes: OrderWish[]): Promise<any> {
    if (wishes.length === 0) {
      return Promise.resolve()
    }

    const orders = wishes.map(this.wishToOrder)
    const startTime = Date.now()
    const completion = this.bitmexClient.postOrders(orders, 1)
      .then(() => {
        writeNetworkLog({ duration: (Date.now() - startTime) / 1000, op: 'post', result: 'ok' })
      })
      .catch((err) => {
        writeNetworkLog({ duration: (Date.now() - startTime) / 1000, op: 'post', result: 'error' })
        log('Order post failed:', err.message)
        // Remove the orders locally and retry but only if this call is the latest action on the orders
        if (_.every(orders, (order) => {
          const state = this.orderStates[order.clOrdID]
          return !state || state.completion === completion
        })) {
          orders.forEach((o) => this.mapDeleteOrder(o.clOrdID))
          this.retryOrderAdjust()
        }
      })
    orders.forEach(o => this.mapUpsertOrder(o, 'posting', completion))
    return completion
  }
}

export class GridOrderManager {
  private currentGridSettings: GridSettings = getDefaultGridSettings()
  private tentativeGridSettings: GridSettings = getDefaultGridSettings()
  private lastGridChangeTime: Date = new Date()

  public currentQuote: Quote | null = null;
  private currentMargin: Margin | null = null;
  private currentPosition: Position | null = null;

  private lastTrade: Trade | null = null;
  private lastFill: Execution | null = null;
  private currentAnchorPrice: number | null = null;
  private currentUp: number | null = null;
  private currentDown: number | null = null;
  
  
  private balanceToOrderSizeRatio: number = config.bot.betRatio
  
  private lastSubmittedNearestBidPrice: number | null = null;
  private lastSubmittedNearestAskPrice: number | null = null;

  private orderToBookBuffer: number = 1.0001;
  private updateGrid: Function;

  constructor(
      private bitmexClient: BitMexExchange,
      private orderSync: OrderSync
  ) {
    this.bitmexClient.subscribe(`quote:${symbol}`, this.onQuote);
    this.bitmexClient.subscribe('margin', this.onMargin);
    this.bitmexClient.subscribe('position', this.onPosition);
    this.bitmexClient.subscribe(`execution:${symbol}`, this.onExecution);
    this.bitmexClient.subscribe(`trade:${symbol}`, this.onTrade);

    this.updateGrid = _.throttle(this.updateGridNonThrottled, 1000, {leading: true, trailing: true})
  }

  // onOrderReject = (order: SubmittedOrder, reason: OrderRejectionReason) => {
  //   // TODO: make sure the rejection reason was cancel due to post-only meeting book

  //   // order was rejected, books must have changed so update the grid
  //   this.updateGrid()
  // }

  onQuote = (quotes: Quote[]) => {
    const quote = quotes.find(q => q.symbol === symbol);
    this.currentQuote = Object.assign(this.currentQuote || {}, quote);
  }

  onMargin = ([margin]: Margin[]) => {
    this.currentMargin = Object.assign(this.currentMargin || {}, margin);
  }

  onPosition = (positions: Position[]) => {
    const position = positions.find(p => p.symbol === symbol);
    if (position) {
      this.currentPosition = Object.assign(this.currentPosition || {}, position);
    }

    if (!this.currentPosition || this.currentPosition.currentQty === 0) {
      console.log('Position changed, no current position:', this.currentPosition)
    }
  }

  onExecution = (executions: Execution[]) => {
    /**
     * TODO: check grid status on executions too, not only on trades?
     * In that case need to make sure that prices already processed on executions are not processed again
     * on trade events.
     */
    
    let didAnchorMove = false
    const minStepSize = 0.001
    const nonNegativeStepMultSell = Math.max(1 + minStepSize, this.getStepMult('Sell'))
    const nonNegativeStepMultBuy = Math.max(1 + minStepSize, this.getStepMult('Buy'))

    executions.forEach(execution => {
      if (execution.ordStatus === 'Filled' && execution.leavesQty === 0 && execution.symbol == symbol) {
        log('Order filled:', execution.clOrdID, execution.side, execution.orderQty, execution.price)
        writeExecutionLog(_.pick(execution, 'price', 'orderQty', 'side', 'lastQty', 'leavesQty', 'avgPrice', 'symbol'))

        // Execution event comes before orderbook updates, use this to update known quotes
        if (this.currentQuote) {
          this.currentQuote.askPrice = Math.max(this.currentQuote.askPrice, execution.price)
          this.currentQuote.bidPrice = Math.min(this.currentQuote.bidPrice, execution.price)
        }

        didAnchorMove = true
        this.currentAnchorPrice = execution.price
        this.currentUp = this.currentAnchorPrice * nonNegativeStepMultSell
        this.currentDown = this.currentAnchorPrice / nonNegativeStepMultBuy

        let counterOrder: OrderWish
        if (execution.side === 'Sell') {
          counterOrder = {
            price: this.currentDown,
            orderQty: this.getOrderSizeNeutral(),
            side: 'Buy',
            execInst: 'ParticipateDoNotInitiate'
          }
        }
        else {
          counterOrder = {
            price: this.currentUp,
            orderQty: this.getOrderSizeNeutral(),
            side: 'Sell',
            execInst: 'ParticipateDoNotInitiate'
          }
        }
        this.orderSync.sendCreateOrders([counterOrder])
      }
      else if (execution.ordStatus === 'Canceled') {
        //log('Order cancelled:', execution.side, execution.orderQty, execution.price, execution.ordRejReason, execution.text)
      }
      else {
        //log('Other execution:', execution)
      }

      if (didAnchorMove) {
        this.updateGrid()
      }
    });
  }

  onTrade = (trades: Trade[]) => {
    // TODO: should not place quotes further than (x%/t seconds) away from last center, protection against spikes

    let didAnchorMove = false
    const minStepSize = 0.001
    const nonNegativeStepMultSell = Math.max(1 + minStepSize, this.getStepMult('Sell'))
    const nonNegativeStepMultBuy = Math.max(1 + minStepSize, this.getStepMult('Buy'))
    const standingAskCount = this.orderSync.getAskCount()
    const standingBidCount = this.orderSync.getBidCount()

    trades.forEach(trade => {
      // Trade event comes before orderbook updates, use this to update known quotes
      if (this.currentQuote) {
        this.currentQuote.askPrice = Math.max(this.currentQuote.askPrice, trade.price)
        this.currentQuote.bidPrice = Math.min(this.currentQuote.bidPrice, trade.price)
      }

      // When out of asks will not get executions, will have to insert counter orders here
      while (standingAskCount === 0 && this.currentUp && trade.price > this.currentUp) {
        log('Trade, crossed up', trade.price, this.currentDown)
        didAnchorMove = true
        this.currentAnchorPrice = this.currentUp
        this.currentUp = this.currentUp * nonNegativeStepMultSell
      }

      // When out of bids will not get executions, will have to insert counter orders here
      while (standingBidCount === 0 && this.currentDown && trade.price < this.currentDown) {
        log('Trade, crossed down', trade.price, this.currentDown)
        didAnchorMove = true
        this.currentAnchorPrice = this.currentDown
        this.currentDown = this.currentDown / nonNegativeStepMultBuy
      }

      this.lastTrade = trade
    })
    
    if (didAnchorMove) {
      this.updateGrid()
    }

  }

  private getOrderSizeNeutral(): number {
    return (this.getCurrentUnrealizedBalanceUSD() || 100) * this.balanceToOrderSizeRatio;
  }

  private updateGridNonThrottled() {
    //log('Updating grid')

    if (!this.currentAnchorPrice && this.currentQuote) {
      this.currentAnchorPrice = (this.currentQuote.askPrice + this.currentQuote.bidPrice) / 2
    }
  
    if (!this.currentQuote || !this.currentAnchorPrice) {
      return
    }

    const asks: OrderWish[] = [];
    const bids: OrderWish[] = [];

    // Note: step size parameters are allowed to be negative. minStepSize applies for calculations where the quote needs to get further from mid price
    const minStepSize = 0.001
    const stepMultSell = this.getStepMult('Sell')
    const stepMultBuy = this.getStepMult('Buy')
    const nonNegativeStepMultSell = Math.max(1 + minStepSize, stepMultSell);
    const nonNegativeStepMultBuy = Math.max(1 + minStepSize, stepMultBuy);
    const meanStepMult = Math.max(1 + minStepSize, (stepMultBuy + stepMultSell) / 2)

    const orderSizeNeutral = this.getOrderSizeNeutral()
    
    const currentPosition = this.currentPosition ? this.currentPosition.currentQty : 0;

    this.currentUp = this.currentAnchorPrice * stepMultSell
    this.currentDown = this.currentAnchorPrice / stepMultBuy

    const midPrice = this.getCurrentMidPrice() || (this.currentUp + this.currentDown) / 2

    // When step size is reducing or negative, we might try to execute against the book. Don't cross the book.
    // Also move the other side of quotes closer.
    if (this.currentUp <= midPrice) {
      this.currentUp = midPrice * this.orderToBookBuffer
      this.currentDown = Math.max(this.currentDown, this.currentUp / meanStepMult / meanStepMult)
    }
    else if (this.currentDown >= midPrice) {
      this.currentDown = midPrice / this.orderToBookBuffer
      this.currentUp = Math.min(this.currentUp, this.currentDown * meanStepMult * meanStepMult)
    }

    const maxOrdersPerSide = this.currentGridSettings.maxOrdersPerSide;
    const stepExpIncrease = this.currentGridSettings.stepExponential;

    const minPosition = -this.currentGridSettings.maxPositionShort * orderSizeNeutral
    const maxPosition = this.currentGridSettings.maxPositionLong * orderSizeNeutral

    const {orderSizeScaleAsk, orderSizeScaleBid} = this.currentGridSettings

    const capTargetByCurrentMaximumPosition = true

    // Target position in absolute USD amounts 
    let targetPosition = this.currentGridSettings.targetPosition * orderSizeNeutral;

    if (capTargetByCurrentMaximumPosition) {
      targetPosition = Math.max(Math.min(targetPosition, maxPosition), minPosition)
    }

    const a = 0.7
    const b = 0.5
    const c = 0.7

    const {orderSizingMethod} = config.bot;
  
    // Generate asks
    let amountBeforeOrder = currentPosition;
    for (let p = this.currentUp, numAsks = 0; amountBeforeOrder > minPosition && numAsks < maxOrdersPerSide; ++numAsks) {
      const scaledOrderSize = orderSizeNeutral * orderSizeScaleAsk;
      const scaledTargetPosition = targetPosition * orderSizeScaleAsk;
      let amount;
      if (orderSizingMethod == 'B') {
        amount = (amountBeforeOrder > targetPosition)
          ? a * Math.abs(amountBeforeOrder - targetPosition) + b * orderSizeNeutral
          : orderSizeNeutral * c / Math.max(1, (targetPosition - amountBeforeOrder) / orderSizeNeutral);
      }
      else {
        amount = scaledOrderSize + (amountBeforeOrder > targetPosition ? Math.abs(amountBeforeOrder - targetPosition) * orderSizeScaleAsk : 0)
      }

      // Without this it's possible for actual maximum position size to be requested max + 1
      amount = Math.min(amount, amountBeforeOrder - minPosition)

      asks.push({
        price: p,
        orderQty: amount,
        side: 'Sell',
        execInst: 'ParticipateDoNotInitiate'})

      amountBeforeOrder -= amount

      // Use exponential increase in step size to sort of offset not laying the full stack of orders
      const stepSize = (nonNegativeStepMultSell - 1) * Math.pow(stepExpIncrease, numAsks + 1);
      p = p * (1 + stepSize)
    }

    amountBeforeOrder = currentPosition;
    for (let p = this.currentDown, numBids = 0; amountBeforeOrder < maxPosition && numBids < maxOrdersPerSide; ++numBids) {
      const scaledOrderSize = orderSizeNeutral * orderSizeScaleBid;
      const scaledTargetPosition = targetPosition * orderSizeScaleBid;
      let amount;
      if (orderSizingMethod == 'B') {
        amount = (amountBeforeOrder < targetPosition)
          ? a * Math.abs(amountBeforeOrder - targetPosition) + b * orderSizeNeutral
          : orderSizeNeutral * c / Math.max(1, (amountBeforeOrder - targetPosition) / orderSizeNeutral);
      }
      else {
        amount = scaledOrderSize + (amountBeforeOrder < targetPosition ? Math.abs(amountBeforeOrder - targetPosition) * orderSizeScaleBid : 0)
      }

      // Without this it's possible for actual maximum position size to be requested max + 1
      amount = Math.min(amount, maxPosition - amountBeforeOrder)

      bids.push({
        price: p,
        orderQty: amount,
        side: 'Buy',
        execInst: 'ParticipateDoNotInitiate'
      })

      amountBeforeOrder += amount

      // Use exponential increase in step size to sort of offset not laying the full stack of orders
      const stepSize = (nonNegativeStepMultBuy - 1) * Math.pow(stepExpIncrease, numBids + 1);
      p = p / (1 + stepSize)
    }

    const wishes = asks.concat(bids)

    //log('Anchor price:', this.currentAnchorPrice, 'up:', this.currentUp, 'down:', this.currentDown)
    // TODO: when ordersync reports cancel, what to do?
    writeTechLog({
      stepSize: meanStepMult - 1,
      orderSize: orderSizeNeutral,
      up: this.currentUp,
      down: this.currentDown,
      ask: this.currentQuote.askPrice,
      bid: this.currentQuote.bidPrice,
      midPrice: midPrice,
      lastPrice: this.lastTrade ? this.lastTrade.price : ''
    })
    this.orderSync.updateWishes(wishes)
  }

  private getStepMult: (side: TradeSide) => number = (side) => {
    const stepSize = side == 'Buy'
      ? this.currentGridSettings.stepSizeBid
      : this.currentGridSettings.stepSizeAsk;

      return 1 + stepSize;
  }

  public getCurrentMidPrice: () => number | null = () => {
    if (!this.currentQuote) {
      return null;
    }
    
    return (this.currentQuote.askPrice + this.currentQuote.bidPrice) / 2
  }

  public getCurrentUnrealizedBalanceBTC: () => number | null = () => {
    if (!this.currentMargin) {
      return null;
    }

    return this.currentMargin.marginBalance / 1e8;
  }

  public getCurrentRealizedBalanceBTC: () => number | null = () => {
    if (!this.currentMargin) {
      return null;
    }

    return this.currentMargin.walletBalance / 1e8;
  }

  public getCurrentRealizedBalanceUSD: () => number | null = () => {
    const midPrice = this.getCurrentMidPrice();
    const realizedBTC = this.getCurrentRealizedBalanceBTC();

    if (!midPrice || !realizedBTC) {
      return null;
    }

    return realizedBTC * midPrice;
  }

  public getCurrentUnrealizedBalanceUSD: () => number | null = () => {
    if (!this.currentMargin) {
      return null
    }

    const midPrice = this.getCurrentMidPrice();
    const unrealizedBTC = this.getCurrentUnrealizedBalanceBTC();

    if (!midPrice || !unrealizedBTC) {
      return null;
    }

    return unrealizedBTC * midPrice;
  }

  public updateGridSettings(grid: GridSettings) {
    const rateLimitLeft = this.bitmexClient.getRateLimitLeftRatio()

    // When half used, 250% (every 1 second), at full rate limit 150%
    const changeThreshold = Math.pow(1 - rateLimitLeft, 2) * 4.0 + config.bot.requestThrottleMinimum;

    const now = new Date()
    const secondsFromLastChange = moment(now).diff(this.lastGridChangeTime, 'ms') / 1000

    const gridKeys: Array<keyof GridSettings> = Object.keys(grid) as Array<keyof GridSettings>;

    // When 1 second has passed, the threshold is applied as is. At 2 seconds, half the change is enough etc.
    const changeAmounts = gridKeys.map(k => Math.abs(this.currentGridSettings[k]) < 0.0001 ? 0 : Math.abs((grid[k] - this.currentGridSettings[k]) / this.currentGridSettings[k]))
    const adjustedAmounts = changeAmounts.map(a => a * secondsFromLastChange)
    const maxChange = Math.max(...adjustedAmounts)

    if (this.orderSync.hasAmendFailed || maxChange > changeThreshold) {
      this.currentGridSettings = Object.assign({}, grid); // Copy to avoid assigning the reference, would point to the same object as in Smartbot
      this.lastGridChangeTime = now;
      this.updateGrid();
    }
  }
}

export default class Smartbot {
  private opts: SmartbotOpts;
  private isPredictionActive: boolean = false;
  private bitmexClient: BitMexExchange;
  private orderSync: OrderSync | null = null;
  private gridManager: GridOrderManager | null = null;
  private predictorApi: PredictorApi;
  private gridSettings: GridSettings = getDefaultGridSettings();
  private writeBalanceLog: Function;
  private currentMargin: Margin | null = null;
  private currentPosition: Position | null = null;

  constructor(opts: Partial<SmartbotOpts>) {
    this.opts = Object.assign({}, SMARTBOT_DEFAULT_OPTS, opts);

    this.predictorApi = new PredictorApi(this.opts.predictorHost, this.opts.predictorPort);
    const bitmexOpts: BitMexOptions = {
      apiKey: this.opts.apiKey,
      apiSecret: this.opts.apiSecret,
      live: this.opts.live
    }

    this.bitmexClient = new BitMexExchange(bitmexOpts)
    this.bitmexClient.connect()

    this.bitmexClient.on('connected', () => {
      this.bitmexClient.subscribe('margin', this.onMargin)
      this.bitmexClient.subscribe('position', this.onPosition)

      if (this.orderSync && this.gridManager) {
        return
      }

      this.orderSync = new OrderSync(this.bitmexClient, 0.0001, 0.01)
      this.gridManager = new GridOrderManager(this.bitmexClient, this.orderSync)
    })

    this.bitmexClient.on('disconnected', () => {
      log('Websocket disconnect, play it safe and crash the whole process to get a restart')
      process.exit(1)
    })

    this.writeBalanceLog = _.throttle((margin: Margin): void => {
      if (config.logs.balance) {
        const row = [
          margin.timestamp,
          margin.marginBalance,
          margin.availableMargin,
          margin.unrealisedPnl,
          this.currentPosition ? this.currentPosition.currentQty : 0,
        ]

        if (this.gridManager !== null) {
          row.push(this.gridManager.getCurrentRealizedBalanceBTC() || '')
          row.push(this.gridManager.getCurrentRealizedBalanceUSD() || '')
          row.push(this.gridManager.getCurrentMidPrice() || '')
        }
        else {
          row.push('')
          row.push('')
          row.push('')
        }

        fs.appendFile(config.logs.balance, row.join(',') + '\n', (err) => {
          if (err)
            console.error('Error writing balance log', err);
        })

        allLoggerInstances.forEach((loggerInstance: Logger | null) => {
          if (!loggerInstance) {
            return;
          }

          loggerInstance.balance({
            marginBalance: margin.marginBalance,
            availableMargin: margin.availableMargin,
            unrealisedPnl: margin.unrealisedPnl,
            unrealizedUsd: this.gridManager ? this.gridManager.getCurrentUnrealizedBalanceUSD() : null,
            realizedBtc: this.gridManager ? this.gridManager.getCurrentRealizedBalanceBTC() : null,
            realizedUsd: this.gridManager ? this.gridManager.getCurrentRealizedBalanceUSD() : null,
          })
          if (this.currentPosition && this.currentPosition.currentQty) {
            loggerInstance.customMeasurement('position', {
              size: this.currentPosition.currentQty,
              avg_entry: this.currentPosition.avgEntryPrice,
              bankrupt_price: this.currentPosition.bankruptPrice
            }, {symbol})
          }
        })
      }
    }, 14000, {leading: false, trailing: true})

  }

  onMargin: (data: Array<Margin>) => void = (data) => {
    if (data.length > 0) {
      const margin: Margin = data[0];

      if (!margin.marginBalance) {
        return;
      }

      if (!this.currentMargin) {
        log('Received first margin update')
        this.currentMargin = margin
      }
      else {
        this.currentMargin = Object.assign(this.currentMargin, _.omitBy(margin, _.isNil))
      }
      this.writeBalanceLog(this.currentMargin);
    }
  }

  onPosition = (positions: Position[]) => {
    positions.forEach(position => logger.customMeasurement('position', {
      avg_entry: position.avgEntryPrice,
      liquidation_price: position.liquidationPrice,
      last_value: position.lastValue,
      last_price: position.lastPrice,
      current_quantity: position.currentQty
    }, {
      symbol: position.symbol
    }))

    const position = positions.find(p => p.symbol === symbol);
    if (position) {
      this.currentPosition = Object.assign(this.currentPosition || {}, position);
    }
  }

  async initializePredictor() {
    log('Setting predictor model to use:', this.opts.predictorModelName)
    try {
      await this.predictorApi.loadModel(this.opts.predictorModelName)
      log('Model set successfully')
    }
    catch (err) {
      log('Error loading model:', err)
      process.exit(1)
    }
  }

  async startPredictLoop() {
    if (this.isPredictionActive) {
      return;
    }
    this.isPredictionActive = true;
    await this.initializePredictor()
    log('Prediction loop started')

    while (this.isPredictionActive) {
      try {
        // This takes about 160ms
        let predictions = await this.predictorApi.predictLatest(this.opts.predictorModelName)
        
        this.applyPrediction(predictions.predictions)
        await bluebird.delay(this.opts.predictionInterval);
      }
      catch (err) {
        if (err instanceof NotReadyError) {
          log('Predictor not ready.')
        }
        else if (err instanceof UninitializedError) {
          log('Predictor uninitialzied.')
          await this.initializePredictor()
        }
        else {
          log('Unexpected predictor error:', err)
        }
        await bluebird.delay(this.opts.predictionNotReadyDelay)
      }
    }
  }

  stopPredictLoop() {
    this.isPredictionActive = false
    log('Prediction loop stopped')
  }

  private predictionSmoothingMa: number = 1 //mrchriz: was 12
  private pastGrids: GridSettings[] = []

  applyPrediction(prediction: Prediction2o) {
    log('Prediction:', prediction)
    logger.customMeasurement('prediction', prediction, {symbol})
    if (prediction.stepSize !== undefined && prediction.stepSize !== null) {
      this.gridSettings.stepSizeAsk = prediction.stepSize;
      this.gridSettings.stepSizeBid = prediction.stepSize;
    }
    if (prediction.maxPosition !== undefined && prediction.maxPosition !== null) {
      this.gridSettings.maxPositionShort = prediction.maxPosition;
      this.gridSettings.maxPositionLong = prediction.maxPosition;
    }
    if (prediction.orderSizeScale !== undefined && prediction.orderSizeScale !== null) {
      this.gridSettings.orderSizeScaleAsk = prediction.orderSizeScale;
      this.gridSettings.orderSizeScaleBid = prediction.orderSizeScale;
    }
    if (prediction.targetPosition !== undefined && prediction.targetPosition !== null) {
      this.gridSettings.targetPosition = prediction.targetPosition;
    }
    if (prediction.stepExponential !== undefined && prediction.stepExponential !== null) {
      this.gridSettings.stepExponential = prediction.stepExponential;
    }
    if (prediction.maxOrdersPerSide !== undefined && prediction.maxOrdersPerSide !== null) {
      this.gridSettings.maxOrdersPerSide = prediction.maxOrdersPerSide;
    }

    Object.keys(defaultGridSettings).forEach((gridSettingKey)  => {
      const key: keyof GridSettings = gridSettingKey as keyof GridSettings;
      const val: number | undefined = prediction[key as keyof Prediction2o];
      if (val !== undefined) {
        this.gridSettings[key] = val;
      }
    })

    if (this.gridManager) {
      let gridToSend: GridSettings
      if (this.predictionSmoothingMa > 1) {
        if (this.pastGrids.length >= this.predictionSmoothingMa) {
          this.pastGrids.shift()
        }
        this.pastGrids.push(Object.assign({}, this.gridSettings))
        gridToSend = objectMean(this.pastGrids)
      }
      else {
        gridToSend = this.gridSettings
      }
      this.gridManager.updateGridSettings(gridToSend)
    }

    fs.appendFileSync('live_prediction_log.csv', `${new Date().toISOString()};${this.gridSettings.stepSizeAsk};${this.gridSettings.maxPositionShort}\n`)
  }
}

const bot = new Smartbot({});
bot.startPredictLoop()

function objectMean<T extends NumberSettingsMap>(a: T[]): T {
  if (a.length === 0) {
    throw new Error('objectMean must not be given an empty array')
  }

  const result: T = Object.assign({}, a[0])

  Object.keys(result).forEach((key) => {
    // Number types are good for mean
    if (typeof result[key] == 'number') {
      result[key] = _.mean(a.map(o => o[key]))
    }
    // Booleans don't average out well, pick the latest value
    else if (typeof result[key] == 'boolean') {
      result[key] = a[a.length-1][key]
    }
  })

  return result
}
