var test = require('node:test');
var assert = require('node:assert/strict');

var invoice = require('../lib/invoice');
var pricing = require('../lib/pricing');
var reports = require('../lib/reports');

// The route builds line items with id, sku, name, hsn, price, and qty; it does not add gstRate.
function makeOrder() {
  var items = [{
    id: 1,
    sku: 'RICE-001',
    name: 'Rice',
    hsn: '1006',
    price: 5000,
    qty: 1
  }];
  var billed = pricing.computeTotals(items, 'SAVE10');

  return {
    id: 2001,
    date: '21/11/2026',
    customer: 'Test Customer',
    paymentMode: 'cash',
    status: 'completed',
    items: items,
    coupon: 'SAVE10',
    subtotal: billed.subtotal,
    discount: billed.discount,
    tax: billed.tax,
    total: billed.total
  };
}

test('billing applies the SAVE10 cap before HSN GST', function () {
  var order = makeOrder();
  var billed = pricing.computeTotals(order.items, order.coupon);

  assert.equal(billed.subtotal, 5000);
  assert.equal(billed.discount, 150);
  assert.equal(billed.tax, 242.5);
  assert.equal(billed.cgst, 121.25);
  assert.equal(billed.sgst, 121.25);
  assert.equal(billed.total, 5092.5);
});

test('invoice figures match the HSN GST, coupon cap, tax split, and total used for billing', function () {
  var order = makeOrder();
  var billed = pricing.computeTotals(order.items, order.coupon);
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(figures.subtotal, 5000);
  assert.equal(figures.rows[0].gstPercent, billed.lines[0].gstPercent);
  assert.equal(figures.rows[0].lineTax, billed.lines[0].tax);
  assert.equal(figures.discount, billed.discount);
  assert.equal(figures.tax, billed.tax);
  assert.equal(figures.cgst, billed.cgst);
  assert.equal(figures.sgst, billed.sgst);
  assert.equal(figures.total, billed.total);
});

test('invoice HTML and GST reconciliation report the billed figures as matched', function () {
  var order = makeOrder();
  var html = invoice.render(order);
  var reconciliation = reports.getGstReconciliation({ orders: [order] });
  var row = reconciliation.rows[0];

  assert.match(html, /GST Amt<\/th>/);
  assert.match(html, /5%/);
  assert.match(html, /₹242\.50/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹5092\.50/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
  assert.equal(reconciliation.mismatchCount, 0);
  assert.equal(row.ledgerTax, 242.5);
  assert.equal(row.invoiceTax, 242.5);
  assert.equal(row.ledgerTotal, 5092.5);
  assert.equal(row.invoiceTotal, 5092.5);
  assert.equal(row.delta, 0);
  assert.equal(row.matched, true);
});
