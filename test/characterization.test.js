// Characterization coverage for existing business behavior.
// All fixtures are in memory; these tests do not use lib/store or persisted app data.
var test = require('node:test');
var assert = require('node:assert/strict');

var coupons = require('../lib/coupons');
var dates = require('../lib/dates');
var inventory = require('../lib/inventory');
var ledger = require('../lib/ledger');
var orders = require('../lib/orders');
var pricing = require('../lib/pricing');
var tax = require('../lib/tax');

test('pricing uses coupon discount before item-specific GST and returns line details', function () {
  var items = [
    { id: 1, name: 'Rice', hsn: '1006', price: 100, qty: 2 },
    { id: 2, name: 'Tea', hsn: '0902', price: 50, qty: 1 }
  ];

  assert.equal(pricing.subtotal(items), 250);
  assert.deepEqual(pricing.computeTotals(items, 'WELCOME'), {
    subtotal: 250,
    discount: 12.5,
    taxable: 237.5,
    tax: 18.05,
    cgst: 9.03,
    sgst: 9.02,
    total: 255.55,
    lines: [
      { id: 1, name: 'Rice', hsn: '1006', gstPercent: 5, gross: 200, discount: 10, taxable: 190, tax: 9.5, net: 199.5 },
      { id: 2, name: 'Tea', hsn: '0902', gstPercent: 18, gross: 50, discount: 2.5, taxable: 47.5, tax: 8.55, net: 56.05 }
    ]
  });
});

test('coupon codes are normalized, validated, capped, and inactive codes are rejected', function () {
  assert.equal(coupons.normalizeCode(' save10 '), 'SAVE10');
  assert.equal(coupons.validate('SAVE10', 500).discount, 50);
  assert.equal(coupons.calculateDiscount(5000, 'SAVE10'), 150);
  assert.equal(coupons.validate('SAVE10', 499).valid, false);
  assert.deepEqual(coupons.validate('DIWALI20', 1500), {
    valid: false,
    error: 'Coupon DIWALI20 has expired'
  });
});

test('tax resolves explicit rates, HSN slabs, fallback rate, and splits GST', function () {
  assert.equal(tax.getRateForItem({ gstRate: 12 }), 0.12);
  assert.equal(tax.getRateForItem({ hsn: '0713' }), 0.05);
  assert.equal(tax.getSlabPercent({ hsn: '0902' }), 18);
  assert.deepEqual(tax.splitCgstSgst(10.01), { cgst: 5.01, sgst: 5 });
});

test('sellable stock excludes reserved units and check rejects quantity equal to sellable stock', function () {
  var products = [{ id: 1, name: 'Rice', stock: 5, reserved: 1 }];

  assert.equal(inventory.getSellableStock(products[0]), 4);
  assert.deepEqual(inventory.check(products, [{ id: 1, qty: 3 }]), { ok: true });
  assert.deepEqual(inventory.check(products, [{ id: 1, qty: 4 }]), {
    ok: false,
    msg: 'Rice is out of stock (4 sellable available)'
  });
  assert.deepEqual(inventory.check(products, [{ id: 9, qty: 1 }]), {
    ok: false,
    msg: 'Unknown product 9'
  });
});

test('reserve reduces physical stock; release restores order lines and releases reserved units', function () {
  var products = [{ id: 1, stock: 5, reserved: 2 }];
  inventory.reserve(products, [{ id: 1, qty: 2 }]);
  assert.equal(products[0].stock, 3);

  inventory.release(products, [{ id: 1, qty: 2 }]);
  assert.equal(products[0].stock, 5);
  assert.equal(products[0].reserved, 2);

  inventory.release(products, [{ productId: 1, qty: 1 }]);
  assert.equal(products[0].stock, 5);
  assert.equal(products[0].reserved, 1);
});

test('cancelling an order restores the committed quantity to physical stock', function () {
  var db = {
    nextOrderId: 1002,
    orders: [{
      id: 1001,
      status: 'completed',
      paymentMode: 'cash',
      items: [{ id: 1, qty: 2 }],
      total: 20
    }],
    products: [{ id: 1, stock: 3, reserved: 0 }],
    customers: []
  };

  var result = orders.cancel(db, 1001, 'Customer request');

  assert.equal(result.ok, true);
  assert.equal(db.products[0].stock, 5);
});

test('orders add defaults and cancellation changes status and reverses Khata debit', function () {
  var db = {
    nextOrderId: 1001,
    orders: [],
    // Physical stock is already reduced for the order being cancelled.
    products: [{ id: 1, stock: 6, reserved: 0 }],
    customers: [{ id: 7, name: 'Asha', openingBalance: 0, totalBilled: 100, totalSettled: 0 }]
  };
  var order = orders.add(db, {
    customerId: 7,
    paymentMode: 'khata',
    items: [{ id: 1, qty: 2 }],
    total: 40
  });

  assert.equal(order.id, 1001);
  assert.equal(order.customer, 'Walk-in');
  assert.equal(order.paymentMode, 'khata');
  assert.equal(order.status, 'completed');
  assert.equal(order.coupon, '');
  assert.equal(db.nextOrderId, 1002);
  assert.equal(orders.get(db, '1001'), order);

  var result = orders.cancel(db, 1001, 'Customer request');
  assert.equal(result.ok, true);
  assert.equal(order.status, 'cancelled');
  assert.equal(order.cancelReason, 'Customer request');
  assert.equal(db.customers[0].totalBilled, 60);
  assert.equal(db.products[0].stock, 8);
  assert.equal(orders.cancel(db, 1001).ok, false);
  assert.equal(db.products[0].stock, 8);
});

test('order listing filters by status and search and sorts by date string', function () {
  var db = { orders: [
    { id: 1, date: '01/11/2021', customer: 'Asha', status: 'completed' },
    { id: 2, date: '15/11/2021', customer: 'Ravi', coupon: 'SAVE10', status: 'cancelled' },
    { id: 3, date: '09/11/2021', customer: 'Asha', status: 'pending' }
  ] };

  assert.deepEqual(orders.list(db, { status: 'cancelled', search: 'save10' }).map(function (o) { return o.id; }), [2]);
  assert.deepEqual(orders.list(db, {}).map(function (o) { return o.id; }), [2, 3, 1]);
});

test('Khata charge checks credit limit and settlement updates totals in memory', function () {
  var db = {
    nextSettlementId: 501,
    customers: [{ id: 1, name: 'Meera', creditLimit: 1000, openingBalance: 100, totalBilled: 200, totalSettled: 50 }],
    settlements: []
  };

  assert.equal(ledger.chargeOrderToKhata(db, 1, 300).ok, true);
  assert.equal(db.customers[0].balance, 550);
  assert.equal(ledger.chargeOrderToKhata(db, 1, 500).ok, false);
  assert.equal(ledger.recordSettlement(db, 1, 50, 'cash', 'counter').ok, true);
  assert.equal(db.customers[0].balance, 500);
  assert.equal(db.settlements[0].id, 501);
  assert.equal(db.settlements[0].note, 'counter');
});

test('date utilities normalize HTML dates and calculate fiscal years', function () {
  assert.equal(dates.normalizeDateKey('2021-11-17'), '17/11/2021');
  assert.equal(dates.getFiscalYear('2021-11-17'), 'FY21-22');
  assert.equal(dates.getFiscalYear('2021-02-17'), 'FY20-21');
});
