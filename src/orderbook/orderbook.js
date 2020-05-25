const SortedMap = require('collections/sorted-map')
const Map = require('collections/map')
const _ = require('lodash')
const Observable = require('observable');


function objectDifference(newValues, oldValues) {
  if (!oldValues) {
    return newValues;
  }

  const result = {}

  Object.keys(newValues).forEach((k) => {
    if (newValues[k] !== oldValues[k]) {
      result[k] = newValues[k]
    }
  })

  return result
}

// Expects the order with the given not to exist in the book already
function addToBook(book, order) {
  let orders;
  if (book.has(order.price)) {
    orders = book.get(order.price);
  }
  else {
    orders = [];
    book.set(order.price, orders)
  }

  orders.push(order);

  return book;
}

function updateToBook(book, order) {
  let orders = book.get(order.price);

  const orderIdx = orders.findIndex(o => o.id === order.id);

  if (orderIdx != -1) {
    orders[orderIdx].size = order.size;
  }
  else {
    throw new Error('Trying to update an order in the orderbook but the order was not found: ' + JSON.stringify(order));
  }
  
  return book;
}

function upsertToBook(book, order) {
  let orders;
  if (book.has(order.price)) {
    orders = book.get(order.price);
  }
  else {
    book.set(order.price, orders = [])
  }

  const orderIdx = orders.findIndex(o => o.id === order.id);

  if (orderIdx != -1) {
    orders[orderIdx].size = order.size;
  }
  else
    orders.push(order);
  
  return book;
}

function removeFromBook(book, order) {
  const existingOrders = book.get(order.price) || [];
  const orderIdx = existingOrders.findIndex(o => o.id === order.id);

  existingOrders.splice(orderIdx, 1);

  if (existingOrders.length == 0)
    book.delete(order.price);

  return book;
}

function orderSizeValueToBtc(order) {
  return order.size / order.price;
}

module.exports = class Orderbook {
  constructor (options = {}) {
    const assignOption = (prop, defaultValue) => this[prop] = options[prop] || defaultValue;

    assignOption('throttleWallUpdates', 1000)
    assignOption('bidIdentifier', 'Buy')
    assignOption('askIdentifier', 'Sell')
    assignOption('sizeMapper', _.identity)
    assignOption('isAddCheck', (order) => order.size !== undefined)

    // If order sizes are in e.g. USD, we may want to convert them to BTC sizes
    if (this.sizeMapper === 'valueToBtc')
      this.sizeMapper = orderSizeValueToBtc;

    this.bids = new SortedMap([], (a,b) => a == b, (a, b) => b - a) // Compare for reverse ordering
    this.asks = new SortedMap([], (a,b) => a == b, (a, b) => a - b)
    //this.bids.contentCompare = (left, right) => {throw new Error(right < left)} // Reverse order so from highest bid to the lowest

    this.ordersById = new Map()

    this.unnotifiedNewOrders = [];
    this.unnotifiedRemovedOrders = [];

    this.wallWatches = {
      [this.bidIdentifier]: [],
      [this.askIdentifier]: [],
    }

    // { ask0: 1000, ask1: 1001, bid10: 900...}
    this.walls = Observable.signal({})
    this.wallsUpdates = Observable.signal(this.walls())

    if (this.throttleWallUpdates) {
      this.notifyUpdates = _.throttle(this._notifyUpdates.bind(this), this.throttleWallUpdates, {
        leading: true,
        trailing: true
      })
    }
    else {
      this.notifyUpdates = this._notifyUpdates.bind(this)
    }
  }

  addOrder (order) {
    let price = parseFloat(order.price);
    order.price = price;

    const {id, side} = order;
    order.size = this.sizeMapper(order)

    this.ordersById.set(id, price);

    const isBid = side === this.bidIdentifier;
    const isAsk = side === this.askIdentifier;

    if (isBid)
      addToBook(this.bids, order);
    else if (isAsk)
      addToBook(this.asks, order);
    else
      throw new Error(`Unrecognized order side: ${side}`);

    this.unnotifiedNewOrders.push([price, isBid]);
  }

  updateOrder (order) {
    let price = this.ordersById.get(order.id);
    order.price = price;

    const {id, side} = order;
    order.size = this.sizeMapper(order)

    const isBid = side === this.bidIdentifier;
    const isAsk = side === this.askIdentifier;

    if (isBid)
      updateToBook(this.bids, order);
    else if (isAsk)
      updateToBook(this.asks, order);
    else
      throw new Error(`Unrecognized order side: ${side}`);

    this.unnotifiedNewOrders.push([price, isBid]);
  }

  upsertOrder (order) {
    const hasExistingMapping = this.ordersById.has(order.id);

    let price;
    if (hasExistingMapping) {
      price = this.ordersById.get(order.id);
    }
    else {
      price = parseFloat(order.price);
    }

    order.price = price;

    const {id, side} = order;

    order.size = this.sizeMapper(order)

    this.ordersById.set(id, price);

    const isBid = side === this.bidIdentifier;
    const isAsk = side === this.askIdentifier;

    if (isBid)
      upsertToBook(this.bids, order);
    else if (isAsk)
      upsertToBook(this.asks, order);
    else
      throw new Error(`Unrecognized order side: ${side}`);

    this.unnotifiedNewOrders.push([price, isBid]);
  }

  removeOrder (order) {
    const id = order.id;

    if (!this.ordersById.has(id)) {
      console.error('Error with order:', order)
      console.error(`Cannot find the order by id ${id} to be removed`)
      return
    }

    const price = this.ordersById.get(id);
    const wasBid = this.bids.has(price);

    if (wasBid) {
      removeFromBook(this.bids, {id, price});
    }
    else {
      removeFromBook(this.asks, {id, price});
    }

    this.ordersById.delete(id);

    this.unnotifiedRemovedOrders.push([price, wasBid]);
  }

  // If orders may contain both adds and removes, this method will handle all in one go instead of using addOrders / removeOrders separately.
  // The benefit is not having to recalculate wall levels twice.
  // Note: For performance reasons this method assumes the input object may be mutated at will. Clone it before if you need to.
  processOrders (orders) {
    orders = [].concat(orders) // Ensure array

    orders.forEach((order) => {
      const isAdd = this.isAddCheck(order);
      if (isAdd) {
        this.addOrder(order);
      }
      else {
        this.removeOrder(order);
      }
    })

    this.notifyUpdates()
  }

  // Note: For performance reasons this method assumes the input object may be mutated at will. Clone it before if you need to.
  addOrders (orders) {
    if (!Array.isArray(orders))
      orders = [orders]

    orders.forEach(this.addOrder.bind(this))
    this.notifyUpdates()
  }

  // Note: For performance reasons this method assumes the input object may be mutated at will. Clone it before if you need to.
  updateOrders (orders) {
    if (!Array.isArray(orders))
      orders = [orders]

    orders.forEach(this.upsertOrder.bind(this))
    this.notifyUpdates()
  }

  
  // Note: For performance reasons this method assumes the input object may be mutated at will. Clone it before if you need to.
  removeOrders (orders) {
    if (!Array.isArray(orders))
      orders = [orders]

    orders.forEach(this.removeOrder.bind(this))
    this.notifyUpdates()
  }

  // If orderbook has wall watches, recalculate the price levels and notify any listeners if price levels are changed due to this orderbook update
  _notifyUpdates() {
    const bidWatchTargets = Object.keys(this.wallWatches[this.bidIdentifier]).sort()
    const askWatchTargets = Object.keys(this.wallWatches[this.bidIdentifier]).sort()
    
    const newWalls = {}

    let bidTotal = 0;
    if (bidWatchTargets.length > 0) {
      let currentWatchIdx = 0;
      this.bids.forEach((orders, price) => {
        let levelTotalSize = _.sumBy(orders, 'size');

        bidTotal += levelTotalSize;

        // If (while) current target size is met, push the price and move to the next target size
        while (bidTotal > bidWatchTargets[currentWatchIdx] && currentWatchIdx < bidWatchTargets.length) {
          let prevWatchPrice = this.wallWatches[this.bidIdentifier][bidWatchTargets[currentWatchIdx]]()
          if (prevWatchPrice != price) {
            newWalls['bid' + bidWatchTargets[currentWatchIdx]] = price
            this.wallWatches[this.bidIdentifier][bidWatchTargets[currentWatchIdx]](price);
          }
            
          currentWatchIdx++;
        }
      })
    }

    let askTotal = 0;
    if (askWatchTargets.length > 0) {
      let currentWatchIdx = 0;
      this.asks.forEach((orders, price) => {
        let levelTotalSize = _.sumBy(orders, 'size');

        askTotal += levelTotalSize;

        // If (while) current target size is met, push the price and move to the next target size
        while (askTotal > askWatchTargets[currentWatchIdx] && currentWatchIdx < askWatchTargets.length) {
          let prevWatchPrice = this.wallWatches[this.askIdentifier][askWatchTargets[currentWatchIdx]]()
          if (prevWatchPrice != price) {
            newWalls['ask' + askWatchTargets[currentWatchIdx]] = price
            this.wallWatches[this.askIdentifier][askWatchTargets[currentWatchIdx]](price);
          }
          currentWatchIdx++;
        }
      })
    }

    this.unnotifiedNewOrders = [];
    this.unnotifiedRemovedOrders = [];
    //console.log(this.bids.toArray())
    //console.log(this.asks.toArray())

    // Rounded just to avoid a few insignificant changes here and there
    newWalls['bidTotal'] = Math.round(bidTotal);
    newWalls['askTotal'] = Math.round(askTotal);

    const changedWalls = objectDifference(newWalls, this.walls())
    if (Object.keys(changedWalls).length > 0) {
      this.wallsUpdates(changedWalls)
      const updatedWalls = Object.assign({}, this.walls(), changedWalls)
      this.walls(updatedWalls)
    }
  }

  // If there is a size mapping in use, the size parameter will match the values after the mapping (e.g. when mapping USD values to BTC, the size parameter here should target a wall total size in BTC)
  wallWatch(side, size, fn) {
    if (!this.wallWatches[side][size]) {
      this.wallWatches[side][size] = Observable.signal()
    }

    // Pass on the subscription but filter out undefined values which is sent while no price updates have been received in the beginning.
    this.wallWatches[side][size]((price) => price !== undefined && fn(price))
  }

  removeWallWatch(side, size) {
    delete this.wallWatches[side][size]
  }
}