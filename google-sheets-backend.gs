const SPREADSHEET_ID = "";

const SHEETS = Object.freeze({
  menus: { name: "Menus", headers: ["id", "createdAt", "archivedAt", "active"] },
  flavors: { name: "Flavors", headers: ["id", "menuId", "position", "name"] },
  orders: { name: "Orders", headers: ["id", "menuId", "name", "nameKey", "updatedAt"] },
  orderItems: { name: "OrderItems", headers: ["orderId", "flavorId", "scoops"] }
});

// Archived events live in their own sheets so the live sheets above stay small regardless of history size.
const ARCHIVE_SHEETS = Object.freeze({
  menus: { name: "MenusArchive", headers: SHEETS.menus.headers },
  flavors: { name: "FlavorsArchive", headers: SHEETS.flavors.headers },
  orders: { name: "OrdersArchive", headers: SHEETS.orders.headers },
  orderItems: { name: "OrderItemsArchive", headers: SHEETS.orderItems.headers }
});

// Short-lived cache so bursts of page loads share one sheet read instead of each re-scanning it.
const CACHE_TTL_SECONDS = 20;
const CACHE_KEYS = Object.freeze({ activeMenu: "activeMenu", history: "history" });

function invalidateCache_() {
  const cache = CacheService.getScriptCache();
  cache.removeAll([CACHE_KEYS.activeMenu, CACHE_KEYS.history]);
}

function doGet(event) {
  const callback = validCallback_(event.parameter.callback || "") ? event.parameter.callback : "";
  let payload;
  try {
    payload = { ok: true, result: handle_(event.parameter) };
  } catch (error) {
    payload = { ok: false, error: error.message || String(error) };
  }

  const json = JSON.stringify(payload);
  const body = callback ? callback + "(" + json + ");" : json;
  return ContentService
    .createTextOutput(body)
    .setMimeType(callback ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
}

function handle_(parameters) {
  const action = parameters.action;
  if (["saveOrder", "cancelOrder", "startNewMenu"].indexOf(action) !== -1) {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const result = dispatch_(parameters);
      invalidateCache_();
      return result;
    } finally {
      lock.releaseLock();
    }
  }
  return dispatch_(parameters);
}

function dispatch_(parameters) {
  if (parameters.action === "getActiveMenu") return getActiveMenu_();
  if (parameters.action === "saveOrder") return saveOrder_(parameters.name, parseJson_(parameters.scoops, {}));
  if (parameters.action === "cancelOrder") return cancelOrder_(parameters.nameKey);
  if (parameters.action === "startNewMenu") return startNewMenu_(parseJson_(parameters.flavors, []));
  if (parameters.action === "getHistory") return getHistory_();
  throw new Error("Unknown action: " + parameters.action);
}

function getActiveMenu_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CACHE_KEYS.activeMenu);
  if (cached !== null) return JSON.parse(cached);

  const data = readStore_();
  const menu = data.menus.find(function (item) { return isTrue_(item.active); });
  let result = null;

  if (menu) {
    const flavors = data.flavors
      .filter(function (flavor) { return flavor.menuId === menu.id; })
      .sort(function (left, right) { return Number(left.position) - Number(right.position); })
      .map(function (flavor) { return { id: flavor.id, name: flavor.name }; });

    const orders = data.orders
      .filter(function (order) { return order.menuId === menu.id; })
      .sort(function (left, right) { return left.name.localeCompare(right.name); })
      .map(function (order) {
        const scoops = {};
        data.orderItems.filter(function (item) { return item.orderId === order.id; }).forEach(function (item) {
          scoops[item.flavorId] = item.scoops;
        });
        return { name: order.name, nameKey: order.nameKey, scoops: scoops };
      });

    result = { id: menu.id, createdAt: stringifyDate_(menu.createdAt), flavors: flavors, orders: orders };
  }

  cache.put(CACHE_KEYS.activeMenu, JSON.stringify(result), CACHE_TTL_SECONDS);
  return result;
}

function saveOrder_(name, scoops) {
  const cleanName = trim_(name);
  if (cleanName === "" || cleanName.length > 80) throw new Error("Enter a name between 1 and 80 characters.");

  const store = getStore_();
  const data = readStore_(store);
  const menu = data.menus.find(function (item) { return isTrue_(item.active); });
  if (!menu) throw new Error("There is no active menu.");

  const nameKey = cleanName.toLowerCase();
  let order = data.orders.find(function (item) { return item.menuId === menu.id && item.nameKey === nameKey; });
  const updatedAt = new Date();

  if (order) {
    setRowValues_(store.orders, order.rowIndex, SHEETS.orders.headers, {
      id: order.id,
      menuId: menu.id,
      name: cleanName,
      nameKey: nameKey,
      updatedAt: updatedAt
    });
  } else {
    order = { id: Utilities.getUuid() };
    appendObject_(store.orders, SHEETS.orders.headers, {
      id: order.id,
      menuId: menu.id,
      name: cleanName,
      nameKey: nameKey,
      updatedAt: updatedAt
    });
  }

  deleteRows_(store.orderItems, data.orderItems.filter(function (item) { return item.orderId === order.id; }).map(function (item) { return item.rowIndex; }));

  const itemRows = [];
  Object.keys(scoops || {}).forEach(function (flavorId) {
    const value = trim_(scoops[flavorId]);
    const existsInMenu = data.flavors.some(function (flavor) { return flavor.menuId === menu.id && flavor.id === flavorId; });
    if (existsInMenu && value !== "" && !isZeroQuantity_(value)) {
      itemRows.push({ orderId: order.id, flavorId: flavorId, scoops: value });
    }
  });
  appendObjects_(store.orderItems, SHEETS.orderItems.headers, itemRows);
}

function cancelOrder_(nameKey) {
  const store = getStore_();
  const data = readStore_(store);
  const menu = data.menus.find(function (item) { return isTrue_(item.active); });
  if (!menu) throw new Error("There is no active menu.");

  const cleanNameKey = trim_(nameKey).toLowerCase();
  const order = data.orders.find(function (item) { return item.menuId === menu.id && item.nameKey === cleanNameKey; });
  if (!order) return;

  deleteRows_(store.orderItems, data.orderItems.filter(function (item) { return item.orderId === order.id; }).map(function (item) { return item.rowIndex; }));
  store.orders.deleteRow(order.rowIndex);
}

function startNewMenu_(flavors) {
  if (!Array.isArray(flavors) || flavors.length === 0) throw new Error("Enter at least one flavor.");
  const names = flavors.map(function (name) { return trim_(name); });
  if (names.some(function (name) { return name === ""; })) throw new Error("Flavor names cannot be blank.");
  const uniqueNames = new Set(names.map(function (name) { return name.toLowerCase(); }));
  if (uniqueNames.size !== names.length) throw new Error("Flavor names must be unique.");

  const store = getStore_();
  const data = readStore_(store);
  const now = new Date();

  const activeMenus = data.menus.filter(function (menu) { return isTrue_(menu.active); });
  if (activeMenus.length) {
    const archiveStore = getArchiveStore_();
    activeMenus.forEach(function (menu) {
      archiveMenu_(store, archiveStore, data, menu, now);
    });
  }

  const menuId = Utilities.getUuid();
  appendObject_(store.menus, SHEETS.menus.headers, { id: menuId, createdAt: now, archivedAt: "", active: true });
  names.forEach(function (name, index) {
    appendObject_(store.flavors, SHEETS.flavors.headers, {
      id: Utilities.getUuid(),
      menuId: menuId,
      position: index + 1,
      name: name
    });
  });
}

// Moves one archived menu (and its flavors/orders/orderItems) out of the live sheets and into the archive sheets.
function archiveMenu_(store, archiveStore, data, menu, archivedAt) {
  appendObject_(archiveStore.menus, SHEETS.menus.headers, {
    id: menu.id,
    createdAt: menu.createdAt,
    archivedAt: archivedAt,
    active: false
  });
  store.menus.deleteRow(menu.rowIndex);

  const flavorRows = data.flavors.filter(function (flavor) { return flavor.menuId === menu.id; });
  if (flavorRows.length) {
    appendObjects_(archiveStore.flavors, SHEETS.flavors.headers, flavorRows.map(function (flavor) {
      return { id: flavor.id, menuId: flavor.menuId, position: flavor.position, name: flavor.name };
    }));
    deleteRows_(store.flavors, flavorRows.map(function (flavor) { return flavor.rowIndex; }));
  }

  const orderRows = data.orders.filter(function (order) { return order.menuId === menu.id; });
  if (!orderRows.length) return;

  appendObjects_(archiveStore.orders, SHEETS.orders.headers, orderRows.map(function (order) {
    return { id: order.id, menuId: order.menuId, name: order.name, nameKey: order.nameKey, updatedAt: order.updatedAt };
  }));
  deleteRows_(store.orders, orderRows.map(function (order) { return order.rowIndex; }));

  const orderIds = {};
  orderRows.forEach(function (order) { orderIds[order.id] = true; });
  const itemRows = data.orderItems.filter(function (item) { return orderIds[item.orderId]; });
  if (!itemRows.length) return;

  appendObjects_(archiveStore.orderItems, SHEETS.orderItems.headers, itemRows.map(function (item) {
    return { orderId: item.orderId, flavorId: item.flavorId, scoops: item.scoops };
  }));
  deleteRows_(store.orderItems, itemRows.map(function (item) { return item.rowIndex; }));
}

// One-time cleanup for data archived before this file introduced the archive sheets. Run manually from the
// Apps Script editor (select this function, then Run) after deploying, then redeploy the web app.
function migrateExistingHistory_() {
  const store = getStore_();
  const archiveStore = getArchiveStore_();
  let data = readStore_(store);
  let menu = data.menus.find(function (item) { return !isTrue_(item.active); });
  while (menu) {
    archiveMenu_(store, archiveStore, data, menu, menu.archivedAt || new Date());
    data = readStore_(store);
    menu = data.menus.find(function (item) { return !isTrue_(item.active); });
  }
}

function getHistory_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CACHE_KEYS.history);
  if (cached !== null) return JSON.parse(cached);

  const archiveData = readStore_(getArchiveStore_());
  const result = archiveData.menus
    .sort(function (left, right) { return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(); })
    .map(function (menu) {
      return {
        id: menu.id,
        createdAt: stringifyDate_(menu.createdAt),
        archivedAt: stringifyDate_(menu.archivedAt),
        orderCount: archiveData.orders.filter(function (order) { return order.menuId === menu.id; }).length
      };
    });

  cache.put(CACHE_KEYS.history, JSON.stringify(result), CACHE_TTL_SECONDS);
  return result;
}

function getStore_() {
  const spreadsheet = SPREADSHEET_ID
    ? SpreadsheetApp.openById(SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error("Create this Apps Script from the Google Sheet, or set SPREADSHEET_ID.");

  return {
    menus: getSheet_(spreadsheet, SHEETS.menus),
    flavors: getSheet_(spreadsheet, SHEETS.flavors),
    orders: getSheet_(spreadsheet, SHEETS.orders),
    orderItems: getSheet_(spreadsheet, SHEETS.orderItems)
  };
}

function getArchiveStore_() {
  const spreadsheet = SPREADSHEET_ID
    ? SpreadsheetApp.openById(SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error("Create this Apps Script from the Google Sheet, or set SPREADSHEET_ID.");

  return {
    menus: getSheet_(spreadsheet, ARCHIVE_SHEETS.menus),
    flavors: getSheet_(spreadsheet, ARCHIVE_SHEETS.flavors),
    orders: getSheet_(spreadsheet, ARCHIVE_SHEETS.orders),
    orderItems: getSheet_(spreadsheet, ARCHIVE_SHEETS.orderItems)
  };
}

function getSheet_(spreadsheet, definition) {
  let sheet = spreadsheet.getSheetByName(definition.name);
  if (!sheet) sheet = spreadsheet.insertSheet(definition.name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(definition.headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function readStore_(store) {
  const sheets = store || getStore_();
  return {
    menus: readRows_(sheets.menus),
    flavors: readRows_(sheets.flavors),
    orders: readRows_(sheets.orders),
    orderItems: readRows_(sheets.orderItems)
  };
}

function readRows_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  return values.slice(1).map(function (row, index) {
    const object = { rowIndex: index + 2 };
    headers.forEach(function (header, column) { object[header] = row[column]; });
    return object;
  });
}

function appendObject_(sheet, headers, object) {
  sheet.appendRow(headers.map(function (header) { return object[header] == null ? "" : object[header]; }));
}

function appendObjects_(sheet, headers, objects) {
  if (!objects.length) return;
  sheet.getRange(sheet.getLastRow() + 1, 1, objects.length, headers.length).setValues(
    objects.map(function (object) {
      return headers.map(function (header) { return object[header] == null ? "" : object[header]; });
    })
  );
}

function setRowValues_(sheet, rowIndex, headers, object) {
  sheet.getRange(rowIndex, 1, 1, headers.length).setValues([
    headers.map(function (header) { return object[header] == null ? "" : object[header]; })
  ]);
}

function deleteRows_(sheet, rowIndexes) {
  rowIndexes.sort(function (left, right) { return right - left; }).forEach(function (rowIndex) {
    sheet.deleteRow(rowIndex);
  });
}

function parseJson_(value, fallback) {
  if (!value) return fallback;
  return JSON.parse(value);
}

function trim_(value) {
  return value == null ? "" : String(value).trim();
}

function isTrue_(value) {
  return value === true || String(value).toLowerCase() === "true";
}

function isZeroQuantity_(value) {
  const count = Number(trim_(value));
  return trim_(value) !== "" && Number.isFinite(count) && count === 0;
}

function stringifyDate_(value) {
  return value instanceof Date ? value.toISOString() : value || null;
}

function validCallback_(value) {
  return /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(value);
}