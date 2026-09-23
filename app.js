(function () {
  "use strict";

  const config = window.APP_CONFIG || {};
  const storageKey = "ice-cream-orders-v1";

  function newId() {
    return typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function readLocalState() {
    const saved = localStorage.getItem(storageKey);
    return saved ? JSON.parse(saved) : { activeMenu: null, history: [] };
  }

  function writeLocalState(state) {
    localStorage.setItem(storageKey, JSON.stringify(state));
  }

  const localStore = {
    async getActiveMenu() {
      return readLocalState().activeMenu;
    },
    async saveOrder(name, scoops) {
      const state = readLocalState();
      if (!state.activeMenu) throw new Error("There is no active menu.");
      const nameKey = name.trim().toLocaleLowerCase();
      const order = { name: name.trim(), nameKey: nameKey, scoops: scoops, updatedAt: new Date().toISOString() };
      const index = state.activeMenu.orders.findIndex(function (item) { return item.nameKey === nameKey; });
      if (index === -1) state.activeMenu.orders.push(order);
      else state.activeMenu.orders[index] = order;
      writeLocalState(state);
    },
    async cancelOrder(nameKey) {
      const state = readLocalState();
      if (!state.activeMenu) throw new Error("There is no active menu.");
      state.activeMenu.orders = state.activeMenu.orders.filter(function (order) {
        return (order.nameKey || order.name.toLocaleLowerCase()) !== nameKey;
      });
      writeLocalState(state);
    },
    async startNewMenu(names) {
      const state = readLocalState();
      if (state.activeMenu) {
        state.activeMenu.archivedAt = new Date().toISOString();
        state.history.unshift(state.activeMenu);
      }
      state.activeMenu = {
        id: newId(),
        createdAt: new Date().toISOString(),
        flavors: names.map(function (name) { return { id: newId(), name: name }; }),
        orders: []
      };
      writeLocalState(state);
    },
    async getHistory() {
      return readLocalState().history.map(function (menu) {
        return { id: menu.id, createdAt: menu.createdAt, archivedAt: menu.archivedAt, orderCount: menu.orders.length };
      });
    }
  };

  async function rpc(name, parameters) {
    const response = await fetch(config.supabaseUrl.replace(/\/$/, "") + "/rest/v1/rpc/" + name, {
      method: "POST",
      headers: {
        apikey: config.supabaseAnonKey,
        Authorization: "Bearer " + config.supabaseAnonKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(parameters || {})
    });
    if (!response.ok) throw new Error((await response.text()) || "Storage request failed.");
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  const supabaseStore = {
    getActiveMenu() { return rpc("get_active_menu"); },
    saveOrder(name, scoops) { return rpc("save_order", { p_name: name, p_scoops: scoops }); },
    cancelOrder(nameKey) { return rpc("cancel_order", { p_name_key: nameKey }); },
    startNewMenu(names) { return rpc("start_new_menu", { p_flavors: names }); },
    getHistory() { return rpc("get_menu_history"); }
  };

  function sheetsRpc(action, parameters) {
    if (!config.sheetsWebAppUrl) throw new Error("Set sheetsWebAppUrl in config.js.");
    return new Promise(function (resolve, reject) {
      const callbackName = "iceCreamSheets" + newId().replace(/\W/g, "");
      const script = document.createElement("script");
      const timeout = setTimeout(function () {
        cleanup();
        reject(new Error("Sheets request timed out."));
      }, 15000);

      function cleanup() {
        clearTimeout(timeout);
        delete window[callbackName];
        script.remove();
      }

      const query = new URLSearchParams(Object.assign({ action: action, callback: callbackName }, parameters || {}));
      window[callbackName] = function (payload) {
        cleanup();
        if (!payload || payload.ok === false) reject(new Error(payload && payload.error ? payload.error : "Sheets request failed."));
        else resolve(payload.result);
      };
      script.onerror = function () {
        cleanup();
        reject(new Error("Could not reach the Sheets backend."));
      };
      script.src = config.sheetsWebAppUrl + (config.sheetsWebAppUrl.includes("?") ? "&" : "?") + query.toString();
      document.head.appendChild(script);
    });
  }

  const sheetsStore = {
    getActiveMenu() { return sheetsRpc("getActiveMenu"); },
    saveOrder(name, scoops) { return sheetsRpc("saveOrder", { name: name, scoops: JSON.stringify(scoops) }); },
    cancelOrder(nameKey) { return sheetsRpc("cancelOrder", { nameKey: nameKey }); },
    startNewMenu(names) { return sheetsRpc("startNewMenu", { flavors: JSON.stringify(names) }); },
    getHistory() { return sheetsRpc("getHistory"); }
  };

  const store = config.backend === "sheets" ? sheetsStore : config.backend === "supabase" ? supabaseStore : localStore;
  const status = document.getElementById("status");

  function setStatus(message, isError) {
    status.textContent = message;
    status.classList.toggle("error", Boolean(isError));
  }

  function savePlanPreview(menu, name, scoops) {
    const nameKey = name.trim().toLocaleLowerCase();
    const order = {
      name: name.trim(),
      nameKey: nameKey,
      scoops: scoops,
      updatedAt: new Date().toISOString()
    };
    const orders = menu.orders.slice();
    const index = orders.findIndex(function (item) {
      return (item.nameKey || item.name.toLocaleLowerCase()) === nameKey;
    });
    if (index === -1) orders.push(order);
    else orders[index] = order;
    try {
      sessionStorage.setItem("ice-cream-plan-preview", JSON.stringify({
        menu: Object.assign({}, menu, { orders: orders })
      }));
    } catch (error) {
    }
  }

  function readPlanPreview() {
    try {
      const saved = sessionStorage.getItem("ice-cream-plan-preview");
      if (!saved) return null;
      sessionStorage.removeItem("ice-cream-plan-preview");
      return JSON.parse(saved).menu;
    } catch (error) {
      return null;
    }
  }

  function quantityText(value) {
    return value == null ? "" : String(value).trim();
  }

  function isZeroQuantity(value) {
    const text = quantityText(value);
    const count = Number(text);
    return text !== "" && Number.isFinite(count) && count === 0;
  }

  function wantsFlavor(value) {
    return quantityText(value) !== "" && !isZeroQuantity(value);
  }

  function describeOrder(order, flavors) {
    const items = flavors.filter(function (flavor) {
      return wantsFlavor(order.scoops[flavor.id]);
    }).map(function (flavor) {
      return flavor.name + ": " + quantityText(order.scoops[flavor.id]);
    });
    return items.length ? items.join(", ") : "No scoops";
  }

  async function showOrders() {
    const form = document.getElementById("order-form");
    const flavorList = document.getElementById("flavor-list");
    const nameInput = document.getElementById("name");
    const menu = await store.getActiveMenu();
    if (!menu) {
      setStatus("No menu has been set yet.");
      return;
    }

    menu.flavors.forEach(function (flavor) {
      const row = document.createElement("tr");
      const labelCell = document.createElement("td");
      const inputCell = document.createElement("td");
      const input = document.createElement("input");
      labelCell.textContent = flavor.name;
      input.type = "text";
      input.name = flavor.id;
      input.setAttribute("aria-label", "Scoops of " + flavor.name);
      inputCell.appendChild(input);
      row.append(labelCell, inputCell);
      flavorList.appendChild(row);
    });

    function loadExistingOrder() {
      const nameKey = nameInput.value.trim().toLocaleLowerCase();
      const existing = menu.orders.find(function (order) {
        return (order.nameKey || order.name.toLocaleLowerCase()) === nameKey;
      });
      menu.flavors.forEach(function (flavor) {
        form.elements[flavor.id].value = "";
      });
      if (!existing) return;
      menu.flavors.forEach(function (flavor) {
        form.elements[flavor.id].value = existing.scoops[flavor.id] || "";
      });
    }

    nameInput.addEventListener("change", loadExistingOrder);
    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      const button = form.querySelector("button");
      const controls = Array.from(form.elements);
      const originalButtonText = button.textContent;
      button.disabled = true;
      controls.forEach(function (control) { control.disabled = true; });
      button.textContent = "Saving...";
      setStatus("Saving your order...");
      const scoops = {};
      menu.flavors.forEach(function (flavor) {
        scoops[flavor.id] = form.elements[flavor.id].value.trim();
      });
      try {
        await store.saveOrder(nameInput.value, scoops);
        savePlanPreview(menu, nameInput.value, scoops);
        setStatus("Order saved. Opening serving plan...");
        location.href = "plan/";
        return;
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        button.disabled = false;
        controls.forEach(function (control) { control.disabled = false; });
        button.textContent = originalButtonText;
      }
    });

    form.hidden = false;
    setStatus("Leave blank or enter 0 for flavors you do not want.");
  }

  async function showPlan() {
    setStatus("Loading serving plan...");
    const menu = readPlanPreview() || await store.getActiveMenu();
    if (!menu) {
      setStatus("No menu has been set yet.");
      return;
    }

    const orders = document.getElementById("orders");
    const ordersBody = orders.querySelector("tbody");
    if (!menu.orders.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 3;
      cell.textContent = "No orders yet.";
      row.appendChild(cell);
      ordersBody.appendChild(row);
    }
    menu.orders.forEach(function (order) {
      const row = document.createElement("tr");
      const nameCell = document.createElement("td");
      const detailsCell = document.createElement("td");
      const cancelCell = document.createElement("td");
      const button = document.createElement("button");
      const nameKey = order.nameKey || order.name.toLocaleLowerCase();

      nameCell.textContent = order.name;
      detailsCell.textContent = describeOrder(order, menu.flavors);
      button.type = "button";
      button.textContent = "Cancel";
      button.setAttribute("aria-label", "Cancel order for " + order.name);
      button.addEventListener("click", async function () {
        button.disabled = true;
        try {
          await store.cancelOrder(nameKey);
          location.reload();
        } catch (error) {
          setStatus(error.message, true);
          button.disabled = false;
        }
      });

      cancelCell.appendChild(button);
      row.append(nameCell, detailsCell, cancelCell);
      ordersBody.appendChild(row);
    });
    orders.hidden = false;

    const plan = window.IceCreamPlanner.buildPlan(menu.flavors, menu.orders);
    if (!plan.events.length) {
      setStatus(menu.orders.length ? "There are no scoops to plan yet." : "There are no orders yet.");
      return;
    }

    const summary = document.getElementById("summary");
    const timeline = document.getElementById("timeline");
    const order = document.createElement("p");
    const exposure = document.createElement("p");
    const bowlWait = document.createElement("p");
    order.textContent = "Bowl order: " + plan.bowlOrder.join(", ");
    exposure.textContent = "Longest container outing: " + plan.maximumExposure;
    bowlWait.textContent = "Longest bowl wait: " + plan.maximumBowlWait;
    summary.append(order, exposure, bowlWait);

    const body = timeline.querySelector("tbody");
    plan.events.forEach(function (item) {
      const row = document.createElement("tr");
      const actionCell = document.createElement("td");
      actionCell.textContent = item.action;
      row.append(actionCell);
      body.appendChild(row);
    });
    summary.hidden = false;
    timeline.hidden = false;
    setStatus("Plan calculated from " + menu.orders.length + " order(s).");
  }

  async function showManager() {
    const form = document.getElementById("menu-form");
    const flavorInput = document.getElementById("flavors");
    setStatus("Loading menu...");
    const menu = await store.getActiveMenu();
    if (menu) flavorInput.value = menu.flavors.map(function (flavor) { return flavor.name; }).join("\n");

    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      const names = flavorInput.value.split(/\r?\n/).map(function (name) { return name.trim(); }).filter(Boolean);
      if (!names.length) return setStatus("Enter at least one flavor.", true);
      const uniqueNames = Array.from(new Set(names.map(function (name) { return name.toLocaleLowerCase(); })));
      if (uniqueNames.length !== names.length) return setStatus("Flavor names must be unique.", true);
      const button = form.querySelector("button");
      button.disabled = true;
      try {
        await store.startNewMenu(names);
        location.reload();
      } catch (error) {
        setStatus(error.message, true);
        button.disabled = false;
      }
    });
    setStatus(menu ? "Current menu loaded." : "Enter the first menu.");
  }

  async function start() {
    try {
      if (document.body.dataset.page === "orders") await showOrders();
      else if (document.body.dataset.page === "plan") await showPlan();
      else if (document.body.dataset.page === "manage") await showManager();
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  start();
}());