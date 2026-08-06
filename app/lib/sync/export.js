import XLSX from "xlsx";
function escapeCsvField(val) {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function ordersToCsv(orders) {
  const headers = [
    "externalId", "reference", "status", "statusName", "orderStatus", "action",
    "tranDate", "createdDate", "lastModifiedDate", "shipDate", "shipComplete",
    "note", "currency",
    "customerEmail", "customerFirstName", "customerLastName", "companyName",
    "shippingAddress1", "shippingCity", "shippingZip", "shippingCountry", "shippingProvince",
    "billingAddress1", "billingCity", "billingZip", "billingCountry", "billingProvince",
    "shippingCost", "shipMethod", "subtotal", "taxTotal", "total", "discountTotal",
    "tracking", "shippedDate", "shipmentStatus", "shippedVia", "packageWeight",
    "otherRefNum", "celigoStoreId", "celigoStoreName", "terms", "salesRep",
    "lineItems", "question",
  ];
  const rows = orders.map((o) => [
    o.externalId, o.reference, o.status, o.statusName, o.orderStatus, o.action,
    o.tranDate, o.createdDate, o.lastModifiedDate, o.shipDate, o.shipComplete,
    o.note, o.currency,
    o.customer?.email, o.customer?.firstName, o.customer?.lastName, o.companyName,
    o.shippingAddress?.address1, o.shippingAddress?.city, o.shippingAddress?.zip, o.shippingAddress?.countryCode, o.shippingAddress?.provinceCode,
    o.billingAddress?.address1, o.billingAddress?.city, o.billingAddress?.zip, o.billingAddress?.countryCode, o.billingAddress?.provinceCode,
    o.shippingCost, o.shipMethod, o.subtotal, o.taxTotal, o.total, o.discountTotal,
    o.tracking, o.trackingShipDate, o.trackingStatus, o.trackingShipMethod, o.trackingPackageWeight,
    o.otherRefNum, o.celigoStoreId, o.celigoStoreName, o.terms, o.salesRep,
    (o.lineItems || []).map((li) => `${li.title} x${li.quantity} @${li.price}`).join(" | "),
    "",
  ].map(escapeCsvField));
  return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
}

export function ordersToExcel(orders) {
  const rows = orders.map((o) => ({
    externalId: o.externalId,
    reference: o.reference,
    status: o.status,
    statusName: o.statusName,
    orderStatus: o.orderStatus,
    action: o.action,
    tranDate: o.tranDate,
    createdDate: o.createdDate,
    lastModifiedDate: o.lastModifiedDate,
    shipDate: o.shipDate,
    shipComplete: o.shipComplete,
    note: o.note,
    currency: o.currency,
    customerEmail: o.customer?.email,
    customerFirstName: o.customer?.firstName,
    customerLastName: o.customer?.lastName,
    companyName: o.companyName,
    shippingAddress1: o.shippingAddress?.address1,
    shippingCity: o.shippingAddress?.city,
    shippingZip: o.shippingAddress?.zip,
    shippingCountry: o.shippingAddress?.countryCode,
    shippingProvince: o.shippingAddress?.provinceCode,
    billingAddress1: o.billingAddress?.address1,
    billingCity: o.billingAddress?.city,
    billingZip: o.billingAddress?.zip,
    billingCountry: o.billingAddress?.countryCode,
    billingProvince: o.billingAddress?.provinceCode,
    shippingCost: o.shippingCost,
    shipMethod: o.shipMethod,
    subtotal: o.subtotal,
    taxTotal: o.taxTotal,
    total: o.total,
    discountTotal: o.discountTotal,
    tracking: o.tracking,
    shippedDate: o.trackingShipDate,
    shipmentStatus: o.trackingStatus,
    shippedVia: o.trackingShipMethod,
    packageWeight: o.trackingPackageWeight,
    otherRefNum: o.otherRefNum,
    celigoStoreId: o.celigoStoreId,
    celigoStoreName: o.celigoStoreName,
    terms: o.terms,
    salesRep: o.salesRep,
    lineItems: (o.lineItems || []).map((li) => `${li.title} x${li.quantity} @${li.price}`).join(" | "),
    question: "",
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Orders");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

