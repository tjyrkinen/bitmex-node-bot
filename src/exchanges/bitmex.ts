import EventEmitter = require('events')
import WebSocket = require('ws')
const signMessage = require('./bitmex_signmessage');
const _ = require('lodash')
import request = require('request-promise')
const qs = require('qs')
const bluebird = require('bluebird')

import Orderbook = require('../orderbook/orderbook')

import * as BMTypes from './bitmex_types';
import { RequestPromiseOptions } from "request-promise";
import { Order, outgoingOrderFields, SubmittedOrder, TradeSymbol, TradeSide, ActionType, Execution, OrderType, Quote } from "./bitmex_types";

import { logConsole as logger } from '../logger';

const TESTNET_BASE = 'testnet.bitmex.com';
const LIVE_BASE = 'www.bitmex.com';

const BASE_URL = LIVE_BASE;
const MAX_CONTINGENT_PER_SIDE: number = 5;

export let LIVE_WS_URL = `wss://${BASE_URL}/realtime`;
export let LIVE_API_URL = `https://${BASE_URL}`;

export let DEFAULT_WS_URL = LIVE_WS_URL;
export let DEFAULT_API_URL = LIVE_API_URL;

export let TEST_WS_URL = `wss://${TESTNET_BASE}/realtime`;
export let TEST_API_URL = `https://${TESTNET_BASE}`;

export type WebSocketMessageEvent = { data: WebSocket.Data; type: string; target: WebSocket }
export type WebSocketCloseEvent = { wasClean: boolean; code: number; reason: string; target: WebSocket }
export type WebSocketOpenEvent = { target: WebSocket }
class WebSocketError extends Error {};

export type LowerCaseHttpMethod = 'get' | 'put' | 'post' | 'delete';

export interface RateLimitCounters {
  limit: number | null;
  remaining: number;
  reset: number | null;
}

export class WebSocketHandler {
  private url: string | Function | null

  private ws: WebSocket | null = null
  private emitter: EventEmitter = new EventEmitter();

  private reconnectCounter: number = 0
  private awaitingReconnect: boolean = false
  private lastMessageReceived: number = 0

  private heartbeatCounter: number = 0
  private heartbeatCheckInterval: NodeJS.Timer | null = null

  constructor (url?: string) {
    this.url = url || null;
    this.emitter
    this.awaitingReconnect = false;

    // Heartbeat handling
    this.lastMessageReceived = Date.now()
    this.emitter.on('message', () => {
      this.lastMessageReceived = Date.now()
    })
    this.heartbeatCounter = 0
    this.emitter.on('open', () => {
      if (this.heartbeatCheckInterval) {
        clearInterval(this.heartbeatCheckInterval);
      }
      this.heartbeatCheckInterval = setInterval(() => {
        this.heartbeatCounter++
        if (this.heartbeatCounter % 12 === 0) {
          logger('Heartbeat OK')
        }
        if (Date.now() > this.lastMessageReceived + 60 * 1000) // Accept a minute without a hearbeat
        {
          logger('No heartbeat received in a minute. Reconnecting websocket.')
          if (this.ws) {
            this.ws.close()            
          }
          this.reconnect()
        }
        try {
          // This can fail at least if connection was recently dropped and reconnection hasn't taken place yet.
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send('ping')
          }
        } catch (err) {
          logger('Failed sending heartbeat ping:', err)
        }
      }, 10000)
    })
  }

  connect = (url?: string | Function) => { 
    if (url) {
      this.url = url
    }

    try {
      let ws = this.ws = new WebSocket(this.getUrl());
      ws.onerror = this.handleError;
      ws.onclose = this.handleClose;
      ws.onmessage = this.handleMessage;
      ws.onopen = this.handleOpen;
    }
    catch (err) {
      this.reconnect();
    }

    return this;
  }

  handleError = (error: WebSocketError) => {
    console.error('WebSocket error', error);
    this.emitter.emit('error', error);

    this.reconnect();
  }

  reconnect = () => {
    if (this.awaitingReconnect) {
      return;
    }

    this.awaitingReconnect = true;
    const timeout = 1000 * Math.pow(1.5, this.reconnectCounter++);
    
    logger(`Attempting to reconnect in ${timeout/1000} seconds`);

    setTimeout(() => {
      this.awaitingReconnect = false;
      this.connect();
    }, timeout)
  }

  handleClose = (event: WebSocketCloseEvent) => {
    logger('WebSocket closed');
    this.emitter.emit('close');

    // Abnormal close
    if (event.code !== 1000) {
      this.reconnect();
    }
  }

  handleMessage = (event: WebSocketMessageEvent) => {
    this.lastMessageReceived = Date.now()
    if (event.data === 'pong') {
      return
    }
    this.emitter.emit('message', event);
  }

  handleOpen = (event: WebSocketOpenEvent) => {
    logger('WebSocket opened to', this.getUrl());
    this.reconnectCounter = 0;
    this.emitter.emit('open', event)
  }

  on = (event: string, handler: (...args: any[]) => void) => {
    this.emitter.on(event, handler);
  }

  send = (message: string) => {
    if (this.ws) {
      this.ws.send(message);
    }
  }

  sendJS = (message: object) => {
    this.send(JSON.stringify(message))
  }

  getUrl: () => string = () => {
    return (typeof this.url === 'function') ? this.url() : this.url;
  }
}


export interface BitMexSubscriptions {
  orderbook: boolean;
  trades: boolean;
  walls: boolean;
  positions: boolean;
  orders: boolean;
  execution: boolean;
  instruments: boolean;
  margin: boolean;
  wallet: boolean;
}


export interface BitMexOptions {
  apiKey: string;
  apiSecret: string;
  live: boolean;
  features?: Partial<BitMexSubscriptions>;
  symbol?: TradeSymbol;
}


export default class BitMexExchange {
  public emitter: EventEmitter = new EventEmitter();
  
  private privateRateLimit: RateLimitCounters = {
    limit: null,
    remaining: 100,
    reset: null
  }

  private publicRateLimit: RateLimitCounters = {
    limit: null,
    remaining: 100,
    reset: null
  }

  private features: BitMexSubscriptions = {
    orderbook: false,
    trades: false,
    walls: false,
    positions: false,
    orders: false,
    execution: false,
    instruments: false,
    margin: false,
    wallet: false,
  }

  private apiKey: string
  private apiSecret: string
  private live: boolean = false
  private wsUrl: string = DEFAULT_WS_URL
  private apiUrl: string = DEFAULT_API_URL

  private rateCounter: number = 0
  private rateCounterInterval: NodeJS.Timer | null = null
  private rateLimitRefresher: NodeJS.Timer | null = null

  public wsClient: WebSocketHandler
  
  public symbol: TradeSymbol = 'XBTUSD'

  // TODO: orderbook ts
  public orderbook: any

  private ordersById: {[orderID: string]: BMTypes.SubmittedOrder} = {}
  private positionsBySymbol: {[symbol: string]: BMTypes.Position} = {}
  private currentQuote: Quote | null = null;

  private margin: BMTypes.Margin | null = null
  private wallet: BMTypes.Wallet | null = null

  private lastExecution: BMTypes.Execution | null = null
  private clOrdIDCounter: number = 0
  private activeSubscriptions: string[] = [];

  public tickSize: number = 0.5
  public minimumQtyMultiplier: number = 0.0026

  constructor (options: BitMexOptions) {
    if (!options.apiKey || !options.apiSecret) {
      throw new Error('BitMex apiKey or apiSecret is empty')
    }

    Object.assign<BitMexSubscriptions, Partial<BitMexSubscriptions>>(this.features, options.features || {});

    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.live = options.live;

    if (this.live) {
      this.wsUrl = LIVE_WS_URL;
      this.apiUrl = LIVE_API_URL;
    }
    else {
      this.wsUrl = TEST_WS_URL;
      this.apiUrl = TEST_API_URL;
    }

    this.wsClient = new WebSocketHandler();
    this.symbol = options.symbol || this.symbol;

    this.wsClient.on('open', () => {
      logger('BitMex WebSocket open')
      if (this.features.orderbook)
        this.subscribe('orderBookL2:' + this.symbol)

      if (this.features.trades)
        this.subscribe(`trade:${this.symbol}`)

      if (this.features.instruments) {
        this.subscribe('instrument:.BXBT')
        this.subscribe('instrument:.XBT')
        this.subscribe('instrument:' + this.symbol)
      }

      if (this.features.positions)
        this.subscribe('position')

      if (this.features.execution)
        this.subscribe('execution')

      if (this.features.orders)
        this.subscribe('order')

      if (this.features.margin)
        this.subscribe('margin')

      if (this.features.wallet)
        this.subscribe('wallet')

      this.activeSubscriptions.forEach((feed) => {
        this.sendOp('subscribe', feed)
      })

      this.emitter.emit('connected')
    })

    this.wsClient.on('close', () => {
      this.emitter.emit('disconnected')
    })

    this.wsClient.on('message', (msg) => this.onMessage(JSON.parse(msg.data)))

    this.rateCounter = 0;
    if (!this.rateCounterInterval) {
      this.rateCounterInterval = setInterval(() => {
        this.rateCounter = 0;
      }, 5000)
    }

    // Authed ratelimits refresh by 1 every second, public refreshes by 1 every 2 seconds
    this.rateLimitRefresher = setInterval(() => {
      this.privateRateLimit.remaining = Math.min(this.privateRateLimit.remaining + 2, 300)
      this.publicRateLimit.remaining = Math.min(this.publicRateLimit.remaining + 1, 150)
    }, 2000)

    this.orderbook = new Orderbook({sizeMapper: 'valueToBtc'})

    if (this.features.walls) {
      this.orderbook.wallWatch('Buy', 0, (price: number) => null && logger('Buy wall 0BTC now at', price))
      this.orderbook.wallWatch('Buy', 1, (price: number) => null && logger('Buy wall 1BTC now at', price))
      this.orderbook.wallWatch('Buy', 10, (price: number) => null && logger('Buy wall 10BTC now at', price))
      this.orderbook.wallWatch('Buy', 100, (price: number) => null && logger('Buy wall 100BTC now at', price))
      this.orderbook.wallWatch('Sell', 0, (price: number) => null && logger('Sell wall 0BTC now at', price))
      this.orderbook.wallWatch('Sell', 1, (price: number) => null && logger('Sell wall 1BTC now at', price))
      this.orderbook.wallWatch('Sell', 10, (price: number) => null && logger('Sell wall 10BTC now at', price))
      this.orderbook.wallWatch('Sell', 100, (price: number) => null && logger('Sell wall 100BTC now at', price))

      this.orderbook.wallsUpdates((walls: {[size: number]: number}) => this.emitter.emit('walls', walls, 'update'))
      this.orderbook.walls((walls: {[size: number]: number}) => this.emitter.emit('walls', walls, 'full'))
    }
  }

  subscribe<T>(feed: string, handler?: (data: T[], actionType: ActionType) => void) {
    const [feedName, instrument] = feed.split(':');
    
    if (!this.activeSubscriptions.includes(feed)) {
      this.sendOp('subscribe', feed);
      this.activeSubscriptions.push(feed)
    }
    if (handler) {
      this.on(feedName, handler);
    }
  }

  getNonce(): number {
    return Date.now()
  }

  getSignedWsUrl = () => {
    if (this.apiKey && this.apiSecret)
      return this.wsUrl + '?' + signMessage.getWSAuthQuery(this.apiKey, this.apiSecret, this.getNonce());
    else
      return this.wsUrl;
  }

  connect = () => {
    this.wsClient.connect(() => this.getSignedWsUrl());
  }

  sendOp (op: BMTypes.WsOp, ...args: string[]) {
    logger('Sending op', op, args)
    const data = {op, args};
    this.wsClient.send(JSON.stringify(data));
  }

  on <T>(event: string, handler: (data: T[], actionType: ActionType) => void) {
    this.emitter.on(event, handler);
  }

  onMessage (msg: BMTypes.WebsocketMessage) {
    //logger(msg);
    switch (msg.table) {
      case 'orderBookL2':
        switch (msg.action) {
          case 'partial': // Initial book
            this.orderbook.addOrders(msg.data);
            break;
          case 'insert':
            this.orderbook.addOrders(msg.data);
            break;
          case 'update':
            this.orderbook.updateOrders(msg.data);
            break;
          case 'delete':
            this.orderbook.removeOrders(msg.data);
            break;
        }
        break;
      case 'trade':
        break;
      case 'instrument':
        switch (msg.action) {
          case 'partial':
          case 'update':
            if (msg.data[0].markPrice) {
              //logger(msg.data[0].symbol, msg.data[0].markPrice)
            }
            if (msg.data[0].indicativeSettlePrice) {
              //logger('Index price', msg.data[0].indicativeSettlePrice)
            }
        }
        break;
      case 'position':
        _.merge(this.positionsBySymbol, _.keyBy(msg.data, 'symbol'))
        break;
      case 'order':
        switch (msg.action) {
          case 'insert':
            this.insertOrders(msg.data, false)
            break;
          case 'update':
            this.updateOrders(msg.data)
            break;
        }
        break;
      case 'execution':
        this._removeFilledOrders(msg.data);
        this._saveLastExecution(msg.data);
        break;
      case 'margin':
        if (msg.data.length > 0) {
          if (!this.margin) {
            this.margin = msg.data[0];
          }
          else {
            Object.assign(this.margin, msg.data[0])
          }
        }
        break;
      case 'wallet':
        if (msg.data.length > 0) {
          if (!this.wallet) {
            this.wallet = msg.data[0];
          }
          else {
            Object.assign(this.wallet, msg.data[0])
          }
        }
        break;
      default:
        break;
    }

    this.emitter.emit(msg.table, msg.data, msg.action);
  }

  _removeFilledOrders (executions: BMTypes.Execution[]) {
    executions.forEach(e => {
      if (e.ordStatus === 'Filled' && e.ordType === 'Limit' && e.leavesQty === 0 && e.text !== 'Funding') {
        delete this.ordersById[e.orderID]
      }
    })
  }

  _saveLastExecution(executions: BMTypes.Execution[]) {
    executions.forEach(e => {
      if (e.ordStatus === 'Filled' && e.ordType === 'Limit' && e.leavesQty === 0 && e.text !== 'Funding') {
        this.lastExecution = e;
      }
    })
  }

  getLastFillPrice(): number | null {
    return this.lastExecution ? this.lastExecution.price : null;
  }

  getBids(): SubmittedOrder[] {
    return Object.values(this.ordersById).filter(order => order.side === 'Buy');
  }

  getAsks(): SubmittedOrder[] {
    return Object.values(this.ordersById).filter(order => order.side === 'Sell');
  }

  getContingentCount(side?: TradeSide): number {
    return Object.values(this.ordersById).filter(order => {
      order.contingencyType === 'OneTriggersTheOther' && (!side || side === order.side);
    }).length
  }

  async http (method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string, data: null | object | object[], {resolveWithFullResponse=false, retryCount=1, noAuth=false} = {}) {
    const doAuth = !noAuth;

    const doSend = () => {
      // More than 50 requests in 5 seconds, throw an error.
      if (this.rateCounter > 50) {
        throw new Error(`API request rate safety trigger: ${this.rateCounter} requests in this 5s window. This request is not made: ${path}`)
      }

      const sendData = method == 'POST' || method == 'PUT';
      const dataStr = sendData && data ? JSON.stringify(data) : '';


      var headers = {
        'content-type' : 'application/json',
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      };

      if (doAuth) {
        //const nonce = Date.now()
        const expires = new Date().getTime() + (60 * 1000) // 1 min in the future
        const signature = signMessage(this.apiSecret, method, path, expires, dataStr)

        Object.assign(headers, {
          'api-expires': expires,
          'api-key': this.apiKey,
          'api-signature': signature
        })
      }

      const url = this.apiUrl + path

      const opts: RequestPromiseOptions & {url: string} = {
        headers,
        url,
        method: method,
        resolveWithFullResponse: true
      }

      if (sendData)
        opts.body = dataStr

      const requestMethod: LowerCaseHttpMethod = method.toLowerCase() as LowerCaseHttpMethod;

      return request[requestMethod](opts)
      .then((result: any) => {
        const rateLimits = doAuth ? this.privateRateLimit : this.publicRateLimit;

        if (result.headers['x-ratelimit-remaining'] && result.headers['x-ratelimit-limit']) {
          rateLimits.limit = Number(result.headers['x-ratelimit-limit'])
          rateLimits.remaining = Number(result.headers['x-ratelimit-remaining'])
          rateLimits.reset = Number(result.headers['x-ratelimit-reset'])
        }

        if (resolveWithFullResponse)
          return result;
        else
          return JSON.parse(result.body);
      })
      .catch((err) => {
        // Ensure that when making bad requests the ratelimit is still updated
        if (err.statusCode >= 400 && err.statusCode <= 499) {
          const rateLimits = doAuth ? this.privateRateLimit : this.publicRateLimit;

          rateLimits.remaining = rateLimits.remaining - 1
        }
        throw err
      })
    };

    let ready = false;
    let result = null;
    let lastErr = null;
    while (!ready && retryCount > 0) {
      try {
        result = await doSend()
        lastErr = null;
        ready = true;
      } catch (err) {
        lastErr = err
        retryCount--;
        logger(`HTTP ${method} ${path} failed: ${err.statusCode} ${err.error}. Retrying ${retryCount} times...`);
        if (err.statusCode < 500 || err.statusCode > 599) {
          logger('This was not a server error. Not retrying.')
          retryCount = 0
        }
        else {
          await bluebird.delay(2000);
        }
      }
    }

    if (result) {
      return result
    }
    else {
      throw lastErr
    }
  }

  getRateLimitLeftRatio() {
    if (!this.privateRateLimit.remaining || !this.privateRateLimit.limit) {
      return 1
    }

    return this.privateRateLimit.remaining / this.privateRateLimit.limit;
  }

  get (path: string, {resolveWithFullResponse=false, retryCount=1, noAuth=false} = {}) {
    return this.http('GET', path, null, {resolveWithFullResponse, retryCount, noAuth})
  }

  post (path: string, data: object, {resolveWithFullResponse=false, retryCount=1} = {}) {
    return this.http('POST', path, data, {resolveWithFullResponse, retryCount})
  }

  put (path: string, data: object, {resolveWithFullResponse=false, retryCount=1} = {}) {
    return this.http('PUT', path, data, {resolveWithFullResponse, retryCount})
  }

  del (path: string, {resolveWithFullResponse=false, retryCount=1} = {}) {
    return this.http('DELETE', path, null, {resolveWithFullResponse, retryCount})
  }

  getRateLimits(account: 'public' | 'private') {
    return account === 'private' ? this.privateRateLimit : this.publicRateLimit;
  }

  withGuardedRateLimit <T>(fn: () => Promise<T>, limitLeft=100): Promise<T> {
    return new Promise((resolve) => {
      if (this.privateRateLimit.remaining === null || this.privateRateLimit.remaining > limitLeft)
        return resolve(fn())
      else {
        const timeUntilReset = (this.privateRateLimit.reset || 1) * 1000 - Date.now();
        logger(`Rate limit guard hit, waiting ${Math.ceil(timeUntilReset / 1000)}s until rate limit reset...`)
        setTimeout(() => {
          resolve(fn())
        }, timeUntilReset)
      }
    })
  }

  // When noAuth is set true, calling the API without authentication, preserving account rate limit.
  getTrades(queryParams={}, {noAuth = false, retryCount=1} = {}) {
    const query = qs.stringify(queryParams)
    return this.get(`/api/v1/trade?${query}`, {noAuth: noAuth, retryCount: retryCount})
  }

  getOrders(opts: {filter?: string | object, reverse?: boolean, count?: number} = {}): Promise<Array<SubmittedOrder>> {
    if (!opts.filter) {
      opts.filter = JSON.stringify({open: true})
    }
    else if (typeof opts.filter === 'object') {
      opts.filter = JSON.stringify(opts.filter)
    }

    const ordersBefore = Object.assign({}, this.ordersById);
    
    const query = qs.stringify(opts)
    return this.get(`/api/v1/order?${query}`)
      .then((orders: Array<SubmittedOrder>) => {
        // We have fresh orders but it's possible that some orders just appeared before the call finished.
        // So remove only the orders we knew of before the query started.
        Object.keys(ordersBefore).forEach(orderId => {
          delete this.ordersById[orderId];
        })
        this.insertOrders(orders, false)
        return orders;
      })
  }

  getTradesBucketed(opts: {binSize: number}) {
    if (!opts.binSize) {
      throw new Error('binSize option not specified')
    }

    const query = qs.stringify(opts)
    return this.get(`/api/v1/trade/bucketed?${query}`)
  }

  getFunding(opts={}) {
    const query = qs.stringify(opts)
    return this.get(`/api/v1/funding?${query}`)
  }

  getPositions(opts={}) {
    const query = qs.stringify(opts)
    return this.get(`/api/v1/position?${query}`)
  }

  deleteOrders(orderIds: string[], retryCount=50) {
    if (orderIds.length === 0) {
      return Promise.resolve()
    }

    const query = qs.stringify({orderID: orderIds})
    return this.del(`/api/v1/order?${query}`, {retryCount: retryCount})
      .then(() => {
        orderIds.forEach(oid => {
          delete this.ordersById[oid]
        })
      })
  }

  deleteAllOrders(opts={}) {
    const query = qs.stringify(opts)
    return this.del(`/api/v1/order/all?${query}`)
  }

  private updateOrders = (orders: SubmittedOrder[]) => {
    orders.forEach(order => {
      if (order.ordStatus === 'Filled' || order.ordStatus === 'Canceled') {
        delete this.ordersById[order.clOrdID]
      }

      if (this.ordersById[order.clOrdID]) {
        Object.assign(this.ordersById[order.clOrdID], order)
      }
    })
  }

  private insertOrders = (orders: SubmittedOrder[], replace=false) => {
    orders = orders.filter(o => o.ordStatus === 'New');

    const indexed = _.keyBy(orders, 'orderID');
    if (replace) {
      this.ordersById = indexed;
    }
    else {
      _.merge(this.ordersById, indexed)
    }
    return orders;
  }

  buildOrder(price: number, side: TradeSide, qty: number): SubmittedOrder {
    return {
      clOrdID: this.getNextClOrdID(),
      symbol: this.symbol,
      ordType: 'Limit' as OrderType,
      execInst: 'ParticipateDoNotInitiate',
      price: price,
      side: side,
      orderQty: qty
    }
  }

  async postOrders(orders: Order[], retryCount=50): Promise<SubmittedOrder[]> {
    if (orders.length === 0) {
      return Promise.resolve([])
    }

    if (this.getRateLimitLeftRatio() < 0.1) {
      return Promise.reject(new Error('Very low rate limit, cannot post'))
    }

    let responseOrders = null;
    
    // Ensure all outgoing orders have a clOrdID
    orders.forEach(order => {
      if (!order.clOrdID) {
        order.clOrdID = this.getNextClOrdID()
      }
    })

    this.fixOrderPricesAndQuantities(orders)

    responseOrders = await this.post(`/api/v1/order/bulk`, {orders}, {retryCount: retryCount}) as SubmittedOrder[]
    this.insertOrders(responseOrders)
    return responseOrders
  }

  getErrorReason(error: any) {
    let reason
    if (error.error && typeof(error.error) === 'string') {
      try {
        reason = JSON.parse(error.error).message
      }
      catch (err) {
        reason = error.message
      }
    }

    return reason
  }

  getLeaderboard(method: 'ROE' | 'notional', retryCount=999): Promise<BMTypes.Leaderboard[]> {
    return this.get(`/api/v1/leaderboard?method=${method}`, {retryCount})
  }

  cancelAllAfter(ms: number) {
    return this.post(`/api/v1/order/cancelAllAfter`, {timeout: ms})
  }

  amendOrders(orders: SubmittedOrder[], retryCount=10, throwErrors=false) {
    if (orders.length == 0) {
      return Promise.resolve()
    }

    if (this.privateRateLimit.remaining < 50) {
      logger('Amending. Ratelimit remaining:', this.privateRateLimit.remaining)
    }

    if (this.getRateLimitLeftRatio() < 0.05) {
      return Promise.reject(new Error('Very low rate limit, cannot amend'))
    }

    orders = this.ordersToAmendFormat(orders)

    this.fixOrderPricesAndQuantities(orders)

    return this.put(`/api/v1/order/bulk`, {orders: orders}, {retryCount: retryCount})
      .then(() => {
        //logger(`Amended ${orders.length} orders`)
      })
      .catch(err => {
        if (throwErrors) {
          throw err
        }
        else {
          logger(`Orders amend failed. Ignoring.`, err.message)
        }
      })
  }

  ordersToAmendFormat(orders: SubmittedOrder[]): SubmittedOrder[] {
    const result = orders.map(filterOutgoingOrderFields)
    // Bulk amend doesn't like clOrdID's :(
    result.forEach(order => {
      if (!order.orderID) {
        throw new Error('Order to amend should have orderID present: ' + JSON.stringify(order));
      }
      delete order.clOrdID
      // The API automatically adds a prefix to text. If order is amended many times the text length explodes, so let's not use text at all.
      order.text = ''
    })
    return result
  }

  // Returns a unique order id based on timestamp and a counter.
  getNextClOrdID(): string {
    return '' + Date.now().toString() + '-' + (this.clOrdIDCounter++).toString();
  }

  // Returns an order of the opposite side and moved by stepMult.
  // ExecInst is cleared, counter orders should always execute.
  // All other fields are the same.
  createCounterOrder(order: Order, stepMult: number): Order {
    if (stepMult < 1) {
      throw new Error('stepMult should be >= 1 in' + JSON.stringify(order));
    }

    return Object.assign({}, order, {
      side: order.side == 'Buy' ? 'Sell' : 'Buy',
      price: order.side == 'Buy' ? order.price * stepMult : order.price / stepMult,
      execInst: ''
    })
  }

  // Mutates the input orders' clOrdLinkID and contingencyType fields.
  // Returns counter orders only.
  createPairedOTOs(orders: Order[], stepMult: number): Order[] {
    const contingentBuyCount: number = this.getContingentCount('Buy');
    const contingentSellCount: number = this.getContingentCount('Sell');
    let contBuysLeft = MAX_CONTINGENT_PER_SIDE - contingentBuyCount;
    let contSellsLeft = MAX_CONTINGENT_PER_SIDE - contingentSellCount;

    const counterOrders: Order[] = _.compact(orders.map(order => {
      if (order.side === 'Buy') {
        if (contBuysLeft < 1) {
          return null
        } 
        else {
          contBuysLeft--;
        }
      }
      else {
        if (contSellsLeft < 1) {
          return null
        } 
        else {
          contSellsLeft--;
        }
      }

      const linkId: string = this.getNextClOrdID();
      
      order.clOrdLinkID = linkId;
      
      const counterOrder = this.createCounterOrder(order, stepMult);

      order.contingencyType = 'OneTriggersTheOther';
      return counterOrder;
    }))

    return this.fixOrderPricesAndQuantities(counterOrders);
  }

  // Mutates the input orders' orderQty and price to valid values.
  // Returns the same orders.
  fixOrderPricesAndQuantities(orders: Order[]): Order[] {
    return orders.map(order => {
      order.orderQty = Math.ceil(Math.max(order.orderQty, order.price * this.minimumQtyMultiplier));
      order.price = Math.round(order.price / this.tickSize) * this.tickSize;
      return order;
    })
  }

  static executionAsOrder(execution: Execution): SubmittedOrder {
    return _.pick(execution, [
      'orderID',
      'clOrdID',
      'clOrdLinkID',
      'contingencyType',
      'symbol',
      'ordType',
      'ordStatus',
      'price',
      'orderQty',
      'side',
      'execInst',
      'text',
      'triggered',
    ])
  }
}

function filterOutgoingOrderFields(order: Order) {
  return _.pick(order, outgoingOrderFields);
}

/* 
767 ->
768 21:35
769 23:29
794 08:19
--
941 19:35
--
972 12:15
983 20:46
984 22:20
986 23:41
988 01:45
--
1001 10:23
1020 12:42
1023 16:42
1026 22:31
1027 23:06
1035 00:13
1049 00:48
--
1054 09:22
---
831 19:43
854 22:32
---
777 01:52
816 08:11
*/
