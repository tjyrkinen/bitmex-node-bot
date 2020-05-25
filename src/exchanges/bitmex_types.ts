export type UID = string;

/*
{ 
  timestamp: '2017-07-08T17:06:58.471Z',
  symbol: 'XBTUSD',
  side: 'Buy',
  size: 48,
  price: 2513.7,
  tickDirection: 'ZeroPlusTick',
  trdMatchID: '54b6b01e-280b-4af2-949e-a9115009fed6',
  grossValue: 1909536,
  homeNotional: 0.01909536,
  foreignNotional: 48 
}
*/

export type WsOp = 'subscribe' | 'unsubscribe'

export type TradeSymbol = 'XBTUSD' | 'XBTZ17'

export interface OrderBookL2Message {
  table: 'orderBookL2'
  data: null //[OrderBookL2]
  action: 'partial' | 'insert' | 'update' | 'delete'
}

export interface TradeMessage {
  table: 'trade'
  data: [Trade]
}

export interface InstrumentMessage {
  table: 'instrument'
  data: [Instrument]
  action: 'partial' | 'update'
}

export interface PositionMessage {
  table: 'position'
  data: [Position]
}

export interface OrderMessage {
  table: 'order'
  data: [SubmittedOrder]
  action: 'update' | 'insert'
}

export interface ExecutionMessage {
  table: 'execution'
  data: [Execution]
}

export interface MarginMessage {
  table: 'margin'
  data: [Margin]
}

export interface WalletMessage {
  table: 'wallet'
  data: [Wallet]
}

export interface QuoteMessage {
  table: 'quote'
  data: [Quote]
}

export type ActionType = 'partial' | 'update' | 'insert' | 'delete'

export type OrderRejectionReason = string

export type WebsocketMessage = (OrderBookL2Message | TradeMessage | InstrumentMessage | PositionMessage | OrderMessage | ExecutionMessage | MarginMessage | WalletMessage | QuoteMessage) & {
  action: ActionType
}

export type ExecInst = 'ParticipateDoNotInitiate' | '';
export type TradeSide = 'Buy' | 'Sell';
export type OrderType = 'Limit' | 'Market';

export interface Order {
  orderID?: string,
  clOrdID?: string,
  clOrdLinkID?: string,
  contingencyType?: 'OneTriggersTheOther' | 'OneCancelsTheOther' | 'OneUpdatesTheOtherAbsolute' | 'OneUpdatesTheOtherProportional',
  symbol: string,
  ordType: OrderType,
  ordStatus?: 'New' | 'Filled' | 'Canceled'
  price: number,
  orderQty: number,
  side: TradeSide,
  execInst?: ExecInst,
  text?: string,
  triggered?: '' | 'NotTriggered' | 'Triggered'
}

export interface SubmittedOrder extends Order {
  clOrdID: string, // The client should enforce that all outgoing orders have a clOrdId
  //orderID: string
}

export interface SubmittedAsk extends SubmittedOrder {
  side: 'Sell'
}

export interface SubmittedBid extends SubmittedOrder {
  side: 'Buy'
}

export const outgoingOrderFields: Array<keyof Order> = ['orderID', 'symbol', 'ordType', 'price', 'orderQty', 'side',
  'text', 'clOrdID', 'clOrdLinkID', 'contingencyType', 'execInst'];

export type Funding = {
  timestamp: string
  symbol: string
  fundingInterval: string
  fundingRate: number
  fundingRateDaily: number
}

export type Trade = {
  time: any,
  timestamp: string,
  symbol: string,
  side: string,
  size: number,
  price:number,
  tickDirection: string,
  trdMatchID: UID,
  grossValue: number,
  homeNotional: number,
  foreignNotional: number
}

export type TradeBucket = {
  timestamp: string,
  symbol: string,
  open: number,
  high: number,
  low: number,
  close: number,
  trades: number,
  volume: number,
  vwap: number,
  lastSize: number,
  turnover: number,
  homeNotional: number,
  foreignNotional: number
}

export type TradeInfluxResult = {
  time: {
    _nanoTime: string
    _nanoISO: string
    toNanoISOString: () => string
  }
  exchange: string
  label: string
  price: number
  quantity: number
  quantity_signed: number
  sessionId: string
  side: string
  type: string
  value: number
  version: string
}

export type Instrument = {
  symbol: string,
  lastPrice: number,

  markPrice?: number,
  indicativeSettlePrice?: number,

  tickSize: number,
  makerFee: number,
  takerFee: number,
  bidPrice: number,
  midPrice: number,
  askPrice: number,
  highPrice: number,
  lowPrice: number,

  timestamp: string
}

export type Quote = {
  timestamp: string,
  symbol: string,
  bidSize: number,
  bidPrice: number,
  askPrice: number,
  askSize: number
}

export type Position = {
  account: number,
  symbol: string,
  currency: string,
  underlying: string,
  quoteCurrency: string,
  commission: number,
  initMarginReq: number,
  maintMarginReq: number,
  riskLimit: number,
  leverage: number,
  crossMargin: true,
  deleveragePercentile: number,
  rebalancedPnl: number,
  prevRealisedPnl: number,
  prevUnrealisedPnl: number,
  prevClosePrice: number,
  openingTimestamp: string,
  openingQty: number,
  openingCost: number,
  openingComm: number,
  openOrderBuyQty: number,
  openOrderBuyCost: number,
  openOrderBuyPremium: number,
  openOrderSellQty: number,
  openOrderSellCost: number,
  openOrderSellPremium: number,
  execBuyQty: number,
  execBuyCost: number,
  execSellQty: number,
  execSellCost: number,
  execQty: number,
  execCost: number,
  execComm: number,
  currentTimestamp: string,
  currentQty: number,
  currentCost: number,
  currentComm: number,
  realisedCost: number,
  unrealisedCost: number,
  grossOpenCost: number,
  grossOpenPremium: number,
  grossExecCost: number,
  isOpen: boolean,
  markPrice: number,
  markValue: number,
  riskValue: number,
  homeNotional: number,
  foreignNotional: number,
  posState: string,
  posCost: number,
  posCost2: number,
  posCross: number,
  posInit: number,
  posComm: number,
  posLoss: number,
  posMargin: number,
  posMaint: number,
  posAllowance: number,
  taxableMargin: number,
  initMargin: number,
  maintMargin: number,
  sessionMargin: number,
  targetExcessMargin: number,
  varMargin: number,
  realisedGrossPnl: number,
  realisedTax: number,
  realisedPnl: number,
  unrealisedGrossPnl: number,
  longBankrupt: number,
  shortBankrupt: number,
  taxBase: number,
  indicativeTaxRate: number,
  indicativeTax: number,
  unrealisedTax: number,
  unrealisedPnl: number,
  unrealisedPnlPcnt: number,
  unrealisedRoePcnt: number,
  simpleQty: number,
  simpleCost: number,
  simpleValue: number,
  simplePnl: number,
  simplePnlPcnt: number,
  avgCostPrice: number,
  avgEntryPrice: number,
  breakEvenPrice: number,
  marginCallPrice: number,
  liquidationPrice: number,
  bankruptPrice: number,
  timestamp: string,
  lastPrice: number,
  lastValue: number
}

export type PositionUpdate = {
  account: number,
  symbol: string,
  currency: string,
  currentTimestamp: string,
  currentQty: number,
  markPrice: number,
  simpleQty: number,
  liquidationPrice: number,
  timestamp: string,
  lastPrice: number
}

/*
{ 
  execID: number,
  orderID: 'b807e5ef-7ac3-5742-3e74-02ad107d3e3b',
  clOrdID: '',
  clOrdLinkID: '',
  account: 18795,
  symbol: 'XBTUSD',
  side: 'Sell',
  lastQty: null,
  lastPx: null,
  underlyingLastPx: null,
  lastMkt: '',
  lastLiquidityInd: '',
  simpleOrderQty: null,
  orderQty: 10,
  price: 2585,
  displayQty: null,
  stopPx: null,
  pegOffsetValue: null,
  pegPriceType: '',
  currency: 'USD',
  settlCurrency: 'XBt',
  execType: 'New',
  ordType: 'Limit',
  timeInForce: 'GoodTillCancel',
  execInst: 'ParticipateDoNotInitiate',
  contingencyType: '',
  exDestination: 'XBME',
  ordStatus: 'New',
  triggered: '',
  workingIndicator: true,
  ordRejReason: '',
  simpleLeavesQty: 0.004,
  leavesQty: 10,
  simpleCumQty: 0,
  cumQty: 0,
  avgPx: null,
  commission: null,
  tradePublishIndicator: '',
  multiLegReportingType: 'SingleSecurity',
  text: 'Submission from www.bitmex.com',
  trdMatchID: '00000000-0000-0000-0000-000000000000',
  execCost: null,
  execComm: null,
  homeNotional: null,
  foreignNotional: null,
  transactTime: '2017-07-06T15:11:56.509Z',
  timestamp: '2017-07-06T15:11:56.509Z' 
}
*/

export type Execution = SubmittedOrder & { 
    execID: string,
    orderID: string,
    clOrdID: string,
    clOrdLinkID: string,
    account: number,
    symbol: string,
    side: TradeSide,
    lastQty: number,
    lastPx: number,
    underlyingLastPx: number,
    lastMkt: string,
    lastLiquidityInd: string,
    simpleOrderQty: number,
    orderQty: number,
    price: number,
    displayQty: number,
    stopPx: number,
    pegOffsetValue: number,
    pegPriceType: string,
    currency: string,
    settlCurrency: string,
    execType: string,
    ordType: string,
    timeInForce: string,
    execInst: string,
    contingencyType: '' | 'OneTriggersTheOther',
    exDestination: string,
    ordStatus: string,
    triggered: string,
    workingIndicator: any,
    ordRejReason: OrderRejectionReason,
    simpleLeavesQty: number,
    leavesQty: number,
    simpleCumQty: number,
    cumQty: number,
    avgPx: number,
    commission: number,
    tradePublishIndicator: string,
    multiLegReportingType: string,
    text: string,
    trdMatchID: string,
    execCost: number,
    execComm: number,
    homeNotional: number,
    foreignNotional: number,
    transactTime: string,
    timestamp: string
}

// Balance values are in satoshis
export type Margin = {
  account: number,
  currency: string, 
  grossMarkValue: number,
  riskValue: number,
  unrealisedPnl: number,
  marginBalance: number,
  walletBalance: number,
  marginLeverage: number,
  excessMargin: number,
  availableMargin: number,
  withdrawableMargin: number,
  timestamp: string, 
  grossLastValue: number
}

type Timestamp = string

export type Wallet = {
  account: number,
  currency: string,
  prevDeposited: number,
  prevWithdrawn: number,
  prevTransferIn: number,
  prevTransferOut: number,
  prevAmount: number,
  prevTimestamp: Timestamp,
  deltaDeposited: number,
  deltaWithdrawn: number,
  deltaTransferIn: number,
  deltaTransferOut: number,
  deltaAmount: number,
  deposited: number,
  withdrawn: number,
  transferIn: number,
  transferOut: number,
  amount: number,
  pendingCredit: number,
  pendingDebit: number,
  confirmedDebit: number,
  timestamp: Timestamp,
  addr: string,
  script: string,
  withdrawalLock: any[]
}

export type Leaderboard = {
  profit: number,
  isRealName: boolean,
  isMe?: boolean,
  name: string
}

/*
{
  "Affiliate": {
    "keys": [
      "account",
      "currency"
    ],
    "types": {
      "account": "long",
      "currency": "string",
      "prevPayout": "long",
      "prevTurnover": "long",
      "prevComm": "long",
      "prevTimestamp": "timestamp",
      "execTurnover": "long",
      "execComm": "long",
      "totalReferrals": "long",
      "totalTurnover": "long",
      "totalComm": "long",
      "payoutPcnt": "float",
      "pendingPayout": "long",
      "timestamp": "timestamp",
      "referrerAccount": "integer"
    }
  },
  "Announcement": {
    "keys": [
      "id"
    ],
    "types": {
      "id": "integer",
      "link": "string",
      "title": "string",
      "content": "string",
      "date": "timestamp"
    }
  },
  "APIKey": {
    "keys": [
      "id"
    ],
    "types": {
      "id": "string",
      "secret": "string",
      "name": "string",
      "nonce": "integer",
      "cidr": "string",
      "permissions": [
        "any"
      ],
      "enabled": "boolean",
      "userId": "integer",
      "created": "timestamp"
    }
  },
  "Broker": {
    "keys": [],
    "types": {}
  },
  "Chat": {
    "keys": [
      "id"
    ],
    "types": {
      "id": "integer",
      "date": "timestamp",
      "user": "string",
      "message": "string",
      "html": "string",
      "fromBot": "boolean"
    }
  },
  "ChatChannel": {
    "keys": [
      "id"
    ],
    "types": {
      "id": "integer",
      "name": "string"
    }
  },
  "ConnectedUsers": {
    "keys": [],
    "types": {
      "users": "integer",
      "bots": "integer"
    }
  },
  "Error": {
    "keys": [
      "error"
    ],
    "types": {
      "error": {
        "message": "string",
        "name": "string"
      }
    }
  },
  "Execution": {
    "keys": [
      "execID"
    ],
    "types": {
      "execID": "guid",
      "orderID": "guid",
      "clOrdID": "string",
      "clOrdLinkID": "string",
      "account": "long",
      "symbol": "string",
      "side": "string",
      "lastQty": "long",
      "lastPx": "float",
      "underlyingLastPx": "float",
      "lastMkt": "string",
      "lastLiquidityInd": "string",
      "simpleOrderQty": "float",
      "orderQty": "long",
      "price": "float",
      "displayQty": "long",
      "stopPx": "float",
      "pegOffsetValue": "float",
      "pegPriceType": "string",
      "currency": "string",
      "settlCurrency": "string",
      "execType": "string",
      "ordType": "string",
      "timeInForce": "string",
      "execInst": "string",
      "contingencyType": "string",
      "exDestination": "string",
      "ordStatus": "string",
      "triggered": "string",
      "workingIndicator": "boolean",
      "ordRejReason": "string",
      "simpleLeavesQty": "float",
      "leavesQty": "long",
      "simpleCumQty": "float",
      "cumQty": "long",
      "avgPx": "float",
      "commission": "float",
      "tradePublishIndicator": "string",
      "multiLegReportingType": "string",
      "text": "string",
      "trdMatchID": "guid",
      "execCost": "long",
      "execComm": "long",
      "homeNotional": "float",
      "foreignNotional": "float",
      "transactTime": "timestamp",
      "timestamp": "timestamp"
    }
  },
  "Funding": {
    "keys": [
      "timestamp",
      "symbol"
    ],
    "types": {
      "timestamp": "timestamp",
      "symbol": "string",
      "fundingInterval": "timespan",
      "fundingRate": "float",
      "fundingRateDaily": "float"
    }
  },
  "IndexComposite": {
    "keys": [
      "timestamp"
    ],
    "types": {
      "timestamp": "timestamp",
      "symbol": "string",
      "indexSymbol": "string",
      "reference": "string",
      "lastPrice": "integer",
      "weight": "integer",
      "logged": "timestamp"
    }
  },
  "Instrument": {
    "keys": [
      "symbol"
    ],
    "types": {
      "symbol": "string",
      "rootSymbol": "string",
      "state": "string",
      "typ": "string",
      "listing": "timestamp",
      "front": "timestamp",
      "expiry": "timestamp",
      "settle": "timestamp",
      "relistInterval": "timespan",
      "inverseLeg": "string",
      "sellLeg": "string",
      "buyLeg": "string",
      "positionCurrency": "string",
      "underlying": "string",
      "quoteCurrency": "string",
      "underlyingSymbol": "string",
      "reference": "string",
      "referenceSymbol": "string",
      "calcInterval": "timespan",
      "publishInterval": "timespan",
      "publishTime": "timespan",
      "maxOrderQty": "long",
      "maxPrice": "float",
      "lotSize": "long",
      "tickSize": "float",
      "multiplier": "long",
      "settlCurrency": "string",
      "underlyingToPositionMultiplier": "long",
      "underlyingToSettleMultiplier": "long",
      "quoteToSettleMultiplier": "long",
      "isQuanto": "boolean",
      "isInverse": "boolean",
      "initMargin": "float",
      "maintMargin": "float",
      "riskLimit": "long",
      "riskStep": "long",
      "limit": "float",
      "capped": "boolean",
      "taxed": "boolean",
      "deleverage": "boolean",
      "makerFee": "float",
      "takerFee": "float",
      "settlementFee": "float",
      "insuranceFee": "float",
      "fundingBaseSymbol": "string",
      "fundingQuoteSymbol": "string",
      "fundingPremiumSymbol": "string",
      "fundingTimestamp": "timestamp",
      "fundingInterval": "timespan",
      "fundingRate": "float",
      "indicativeFundingRate": "float",
      "rebalanceTimestamp": "timestamp",
      "rebalanceInterval": "timespan",
      "openingTimestamp": "timestamp",
      "closingTimestamp": "timestamp",
      "sessionInterval": "timespan",
      "prevClosePrice": "float",
      "limitDownPrice": "float",
      "limitUpPrice": "float",
      "bankruptLimitDownPrice": "float",
      "bankruptLimitUpPrice": "float",
      "prevTotalVolume": "long",
      "totalVolume": "long",
      "volume": "long",
      "volume24h": "long",
      "prevTotalTurnover": "long",
      "totalTurnover": "long",
      "turnover": "long",
      "turnover24h": "long",
      "prevPrice24h": "float",
      "vwap": "float",
      "highPrice": "float",
      "lowPrice": "float",
      "lastPrice": "float",
      "lastPriceProtected": "float",
      "lastTickDirection": "string",
      "lastChangePcnt": "float",
      "bidPrice": "float",
      "midPrice": "float",
      "askPrice": "float",
      "impactBidPrice": "float",
      "impactMidPrice": "float",
      "impactAskPrice": "float",
      "hasLiquidity": "boolean",
      "openInterest": "long",
      "openValue": "long",
      "fairMethod": "string",
      "fairBasisRate": "float",
      "fairBasis": "float",
      "fairPrice": "float",
      "markMethod": "string",
      "markPrice": "float",
      "indicativeTaxRate": "float",
      "indicativeSettlePrice": "float",
      "settledPrice": "float",
      "timestamp": "timestamp"
    }
  },
  "InstrumentInterval": {
    "keys": [],
    "types": {
      "intervals": [
        "string"
      ],
      "symbols": [
        "string"
      ]
    }
  },
  "Insurance": {
    "keys": [
      "currency",
      "timestamp"
    ],
    "types": {
      "currency": "string",
      "timestamp": "timestamp",
      "walletBalance": "long"
    }
  },
  "Leaderboard": {
    "keys": [
      "name"
    ],
    "types": {
      "name": "string",
      "isRealName": "boolean",
      "isMe": "boolean",
      "profit": "integer"
    }
  },
  "Liquidation": {
    "keys": [
      "orderID"
    ],
    "types": {
      "orderID": "guid",
      "symbol": "string",
      "side": "string",
      "price": "float",
      "leavesQty": "long"
    }
  },
  "LiquidationOrder": {
    "keys": [],
    "types": {
      "symbol": "string",
      "side": "string",
      "qty": "integer",
      "price": "integer"
    }
  },
  "LoginRecord": {
    "keys": [
      "id"
    ],
    "types": {
      "id": "integer",
      "date": "timestamp",
      "userId": "integer",
      "ip": "string"
    }
  },
  "Margin": {
    "keys": [
      "account",
      "currency"
    ],
    "types": {
      "account": "long",
      "currency": "string",
      "riskLimit": "long",
      "prevState": "string",
      "state": "string",
      "action": "string",
      "amount": "long",
      "pendingCredit": "long",
      "pendingDebit": "long",
      "confirmedDebit": "long",
      "prevRealisedPnl": "long",
      "prevUnrealisedPnl": "long",
      "grossComm": "long",
      "grossOpenCost": "long",
      "grossOpenPremium": "long",
      "grossExecCost": "long",
      "grossMarkValue": "long",
      "riskValue": "long",
      "taxableMargin": "long",
      "initMargin": "long",
      "maintMargin": "long",
      "sessionMargin": "long",
      "targetExcessMargin": "long",
      "varMargin": "long",
      "realisedPnl": "long",
      "unrealisedPnl": "long",
      "indicativeTax": "long",
      "unrealisedProfit": "long",
      "syntheticMargin": "long",
      "walletBalance": "long",
      "marginBalance": "long",
      "marginBalancePcnt": "float",
      "marginLeverage": "float",
      "marginUsedPcnt": "float",
      "excessMargin": "long",
      "excessMarginPcnt": "float",
      "availableMargin": "long",
      "withdrawableMargin": "long",
      "timestamp": "timestamp",
      "grossLastValue": "long",
      "commission": "float"
    }
  },
  "Notification": {
    "keys": [
      "id"
    ],
    "types": {
      "id": "integer",
      "date": "timestamp",
      "title": "string",
      "body": "string",
      "ttl": "integer",
      "type": "string",
      "closable": "boolean",
      "persist": "boolean",
      "waitForVisibility": "boolean",
      "sound": "string"
    }
  },
  "Order": {
    "keys": [
      "orderID"
    ],
    "types": {
      "orderID": "guid",
      "clOrdID": "string",
      "clOrdLinkID": "string",
      "account": "long",
      "symbol": "string",
      "side": "string",
      "simpleOrderQty": "float",
      "orderQty": "long",
      "price": "float",
      "displayQty": "long",
      "stopPx": "float",
      "pegOffsetValue": "float",
      "pegPriceType": "string",
      "currency": "string",
      "settlCurrency": "string",
      "ordType": "string",
      "timeInForce": "string",
      "execInst": "string",
      "contingencyType": "string",
      "exDestination": "string",
      "ordStatus": "string",
      "triggered": "string",
      "workingIndicator": "boolean",
      "ordRejReason": "string",
      "simpleLeavesQty": "float",
      "leavesQty": "long",
      "simpleCumQty": "float",
      "cumQty": "long",
      "avgPx": "float",
      "multiLegReportingType": "string",
      "text": "string",
      "transactTime": "timestamp",
      "timestamp": "timestamp"
    }
  },
  "OrderBook": {
    "keys": [
      "symbol",
      "level"
    ],
    "types": {
      "symbol": "string",
      "level": "long",
      "bidSize": "long",
      "bidPrice": "float",
      "askPrice": "float",
      "askSize": "long",
      "timestamp": "timestamp"
    }
  },
  "OrderBookL2": {
    "keys": [
      "symbol",
      "id",
      "side"
    ],
    "types": {
      "symbol": "string",
      "id": "long",
      "side": "string",
      "size": "long",
      "price": "float"
    }
  },
  "Position": {
    "keys": [
      "account",
      "symbol",
      "currency"
    ],
    "types": {
      "account": "long",
      "symbol": "string",
      "currency": "string",
      "underlying": "string",
      "quoteCurrency": "string",
      "commission": "float",
      "initMarginReq": "float",
      "maintMarginReq": "float",
      "riskLimit": "long",
      "leverage": "float",
      "crossMargin": "boolean",
      "deleveragePercentile": "float",
      "rebalancedPnl": "long",
      "prevRealisedPnl": "long",
      "prevUnrealisedPnl": "long",
      "prevClosePrice": "float",
      "openingTimestamp": "timestamp",
      "openingQty": "long",
      "openingCost": "long",
      "openingComm": "long",
      "openOrderBuyQty": "long",
      "openOrderBuyCost": "long",
      "openOrderBuyPremium": "long",
      "openOrderSellQty": "long",
      "openOrderSellCost": "long",
      "openOrderSellPremium": "long",
      "execBuyQty": "long",
      "execBuyCost": "long",
      "execSellQty": "long",
      "execSellCost": "long",
      "execQty": "long",
      "execCost": "long",
      "execComm": "long",
      "currentTimestamp": "timestamp",
      "currentQty": "long",
      "currentCost": "long",
      "currentComm": "long",
      "realisedCost": "long",
      "unrealisedCost": "long",
      "grossOpenCost": "long",
      "grossOpenPremium": "long",
      "grossExecCost": "long",
      "isOpen": "boolean",
      "markPrice": "float",
      "markValue": "long",
      "riskValue": "long",
      "homeNotional": "float",
      "foreignNotional": "float",
      "posState": "string",
      "posCost": "long",
      "posCost2": "long",
      "posCross": "long",
      "posInit": "long",
      "posComm": "long",
      "posLoss": "long",
      "posMargin": "long",
      "posMaint": "long",
      "posAllowance": "long",
      "taxableMargin": "long",
      "initMargin": "long",
      "maintMargin": "long",
      "sessionMargin": "long",
      "targetExcessMargin": "long",
      "varMargin": "long",
      "realisedGrossPnl": "long",
      "realisedTax": "long",
      "realisedPnl": "long",
      "unrealisedGrossPnl": "long",
      "longBankrupt": "long",
      "shortBankrupt": "long",
      "taxBase": "long",
      "indicativeTaxRate": "float",
      "indicativeTax": "long",
      "unrealisedTax": "long",
      "unrealisedPnl": "long",
      "unrealisedPnlPcnt": "float",
      "unrealisedRoePcnt": "float",
      "simpleQty": "float",
      "simpleCost": "float",
      "simpleValue": "float",
      "simplePnl": "float",
      "simplePnlPcnt": "float",
      "avgCostPrice": "float",
      "avgEntryPrice": "float",
      "breakEvenPrice": "float",
      "marginCallPrice": "float",
      "liquidationPrice": "float",
      "bankruptPrice": "float",
      "timestamp": "timestamp",
      "lastPrice": "float",
      "lastValue": "long"
    }
  },
  "Quote": {
    "keys": [
      "timestamp",
      "symbol"
    ],
    "types": {
      "timestamp": "timestamp",
      "symbol": "string",
      "bidSize": "long",
      "bidPrice": "float",
      "askPrice": "float",
      "askSize": "long"
    }
  },
  "Role": {
    "keys": [],
    "types": {}
  },
  "Secret": {
    "keys": [
      "id"
    ],
    "types": {
      "id": "integer",
      "key": "string",
      "value": "string",
      "created": "timestamp",
      "ttl": "integer"
    }
  },
  "Settlement": {
    "keys": [
      "timestamp",
      "symbol"
    ],
    "types": {
      "timestamp": "timestamp",
      "symbol": "string",
      "settlementType": "string",
      "settledPrice": "float",
      "bankrupt": "long",
      "taxBase": "long",
      "taxRate": "float"
    }
  },
  "Stats": {
    "keys": [
      "rootSymbol"
    ],
    "types": {
      "rootSymbol": "string",
      "currency": "string",
      "volume24h": "integer",
      "turnover24h": "integer",
      "openInterest": "integer",
      "openValue": "integer"
    }
  },
  "StatsHistory": {
    "keys": [
      "date",
      "rootSymbol"
    ],
    "types": {
      "date": "timestamp",
      "rootSymbol": "string",
      "currency": "string",
      "volume": "integer",
      "turnover": "integer"
    }
  },
  "StatsUSD": {
    "keys": [
      "rootSymbol"
    ],
    "types": {
      "rootSymbol": "string",
      "currency": "string",
      "turnover24h": "integer",
      "turnover30d": "integer",
      "turnover365d": "integer",
      "turnover": "integer"
    }
  },
  "Trade": {
    "keys": [
      "timestamp",
      "symbol"
    ],
    "types": {
      "timestamp": "timestamp",
      "symbol": "string",
      "side": "string",
      "size": "long",
      "price": "float",
      "tickDirection": "string",
      "trdMatchID": "guid",
      "grossValue": "long",
      "homeNotional": "float",
      "foreignNotional": "float"
    }
  },
  "TradeBin": {
    "keys": [
      "timestamp",
      "symbol"
    ],
    "types": {
      "timestamp": "timestamp",
      "symbol": "string",
      "open": "float",
      "high": "float",
      "low": "float",
      "close": "float",
      "trades": "long",
      "volume": "long",
      "vwap": "float",
      "lastSize": "long",
      "turnover": "long",
      "homeNotional": "float",
      "foreignNotional": "float"
    }
  },
  "Transaction": {
    "keys": [
      "transactID"
    ],
    "types": {
      "transactID": "guid",
      "account": "long",
      "currency": "string",
      "transactType": "string",
      "amount": "long",
      "fee": "long",
      "transactStatus": "string",
      "address": "string",
      "tx": "string",
      "text": "string",
      "transactTime": "timestamp",
      "timestamp": "timestamp"
    }
  },
  "User": {
    "keys": [
      "id"
    ],
    "types": {
      "id": "integer",
      "ownerId": "integer",
      "firstname": "string",
      "lastname": "string",
      "username": "string",
      "email": "string",
      "phone": "string",
      "created": "timestamp",
      "lastUpdated": "timestamp",
      "preferences": "UserPreferences",
      "TFAEnabled": "string",
      "affiliateID": "string",
      "pgpPubKey": "string",
      "country": "string"
    }
  },
  "UserCommission": {
    "keys": [],
    "types": {
      "makerFee": "integer",
      "takerFee": "integer",
      "settlementFee": "integer",
      "maxFee": "integer"
    }
  },
  "UserPreferences": {
    "keys": [],
    "types": {
      "alertOnLiquidations": "boolean",
      "animationsEnabled": "boolean",
      "announcementsLastSeen": "timestamp",
      "chatChannelID": "integer",
      "colorTheme": "string",
      "currency": "string",
      "debug": "boolean",
      "disableEmails": [
        "string"
      ],
      "hideConfirmDialogs": [
        "string"
      ],
      "hideConnectionModal": "boolean",
      "hideFromLeaderboard": "boolean",
      "hideNameFromLeaderboard": "boolean",
      "hideNotifications": [
        "string"
      ],
      "locale": "string",
      "msgsSeen": [
        "string"
      ],
      "orderBookBinning": "object",
      "orderBookType": "string",
      "orderClearImmediate": "boolean",
      "orderControlsPlusMinus": "boolean",
      "showLocaleNumbers": "boolean",
      "sounds": [
        "string"
      ],
      "strictIPCheck": "boolean",
      "strictTimeout": "boolean",
      "tickerGroup": "string",
      "tickerPinned": "boolean",
      "tradeLayout": "string"
    }
  },
  "Wallet": {
    "keys": [
      "account",
      "currency"
    ],
    "types": {
      "account": "long",
      "currency": "string",
      "prevDeposited": "long",
      "prevWithdrawn": "long",
      "prevTransferIn": "long",
      "prevTransferOut": "long",
      "prevAmount": "long",
      "prevTimestamp": "timestamp",
      "deltaDeposited": "long",
      "deltaWithdrawn": "long",
      "deltaTransferIn": "long",
      "deltaTransferOut": "long",
      "deltaAmount": "long",
      "deposited": "long",
      "withdrawn": "long",
      "transferIn": "long",
      "transferOut": "long",
      "amount": "long",
      "pendingCredit": "long",
      "pendingDebit": "long",
      "confirmedDebit": "long",
      "timestamp": "timestamp",
      "addr": "string",
      "script": "string",
      "withdrawalLock": "symbols"
    }
  },
  "Webhook": {
    "keys": [
      "id"
    ],
    "types": {
      "id": "integer",
      "created": "timestamp",
      "userId": "integer",
      "ownerId": "integer",
      "url": "string"
    }
  }
}
*/
