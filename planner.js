(function (root, factory) {
  const planner = factory();
  if (typeof module === "object" && module.exports) module.exports = planner;
  else root.IceCreamPlanner = planner;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SECONDS = Object.freeze({ remove: 1, scoop: 1, replace: 1, deliver: 1 });

  function permutations(items) {
    if (items.length < 2) return [items.slice()];
    const result = [];
    items.forEach(function (item, index) {
      const rest = items.slice(0, index).concat(items.slice(index + 1));
      permutations(rest).forEach(function (tail) { result.push([item].concat(tail)); });
    });
    return result;
  }

  function quantityText(value) {
    return value == null ? "" : String(value).trim();
  }

  function isZeroQuantity(value) {
    const text = quantityText(value);
    const count = Number(text);
    return text !== "" && Number.isFinite(count) && count === 0;
  }

  function wantsFlavor(order, flavorId) {
    return quantityText(order.scoops[flavorId]) !== "" && !isZeroQuantity(order.scoops[flavorId]);
  }

  function scoopUnits(value) {
    const count = Number(quantityText(value));
    return Number.isFinite(count) && count > 0 ? count : 1;
  }

  function candidateOrders(orders) {
    if (orders.length <= 8) return permutations(orders);
    const totals = new Map(orders.map(function (order) {
      const total = Object.values(order.scoops).reduce(function (sum, count) {
        return sum + (quantityText(count) === "" || isZeroQuantity(count) ? 0 : scoopUnits(count));
      }, 0);
      return [order.name, total];
    }));
    return [
      orders.slice(),
      orders.slice().sort(function (a, b) { return totals.get(a.name) - totals.get(b.name); }),
      orders.slice().sort(function (a, b) { return totals.get(b.name) - totals.get(a.name); })
    ];
  }

  function simulate(bowlOrder, flavors) {
    let time = 0;
    let maximumExposure = 0;
    const events = [];
    const firstScoop = new Map();
    const servedAt = new Map();
    const removedAt = new Map();
    const lastBowl = new Map();
    const exposureDurations = [];
    const bowlServeLatency = [];

    bowlOrder.forEach(function (order, index) {
      flavors.forEach(function (flavor) {
        if (wantsFlavor(order, flavor.id)) lastBowl.set(flavor.id, index);
      });
    });

    function addEvent(action, duration) {
      events.push({ start: time, duration: duration, action: action });
      time += duration;
    }

    bowlOrder.forEach(function (order, bowlIndex) {
      let bowlFirstRemove = null;
      flavors.forEach(function (flavor) {
        const quantity = quantityText(order.scoops[flavor.id]);
        if (!wantsFlavor(order, flavor.id)) return;
        if (!removedAt.has(flavor.id)) {
          removedAt.set(flavor.id, time);
          addEvent("Take out " + flavor.name, SECONDS.remove);
          if (bowlFirstRemove === null) bowlFirstRemove = time;
        }
        if (!firstScoop.has(order.name)) firstScoop.set(order.name, time);
        addEvent("Scoop " + quantity + " " + flavor.name + " for " + order.name, scoopUnits(quantity) * SECONDS.scoop);
        if (lastBowl.get(flavor.id) === bowlIndex) {
          addEvent("Put away " + flavor.name, SECONDS.replace);
          maximumExposure = Math.max(maximumExposure, time - removedAt.get(flavor.id));
          exposureDurations.push(time - removedAt.get(flavor.id));
        }
      });
      addEvent("Deliver bowl to " + order.name, SECONDS.deliver);
      servedAt.set(order.name, time);
      if (bowlFirstRemove !== null) bowlServeLatency.push(time - bowlFirstRemove);
    });

    const waits = bowlOrder.filter(function (order) { return servedAt.has(order.name); }).map(function (order) {
      return servedAt.get(order.name) - firstScoop.get(order.name);
    });
    const exposureOrder = exposureDurations.slice().sort(function (a, b) { return b - a; });
    return {
      events: events,
      bowlOrder: bowlOrder.map(function (order) { return order.name; }),
      maximumExposure: maximumExposure,
      exposureOrder: exposureOrder,
      maximumBowlWait: waits.length ? Math.max.apply(null, waits) : 0,
      bowlServeLatency: bowlServeLatency.slice().sort(function (a, b) { return b - a; }),
      totalBowlWait: waits.reduce(function (sum, wait) { return sum + wait; }, 0),
      finishTime: time
    };
  }

  function buildPlan(flavors, rawOrders) {
    const orders = rawOrders.filter(function (order) {
      return Object.values(order.scoops).some(function (count) {
        return quantityText(count) !== "" && !isZeroQuantity(count);
      });
    });
    const usedFlavors = flavors.filter(function (flavor) {
      return orders.some(function (order) { return wantsFlavor(order, flavor.id); });
    });
    if (!orders.length || !usedFlavors.length) return simulate([], []);

    return candidateOrders(orders).map(function (order) {
      return simulate(order, usedFlavors);
    }).sort(function (left, right) {
      const leftExposure = left.exposureOrder.slice().sort(function (a, b) { return b - a; });
      const rightExposure = right.exposureOrder.slice().sort(function (a, b) { return b - a; });
      for (let index = 0; index < Math.max(leftExposure.length, rightExposure.length); index += 1) {
        const leftValue = leftExposure[index] || 0;
        const rightValue = rightExposure[index] || 0;
        if (leftValue !== rightValue) return leftValue - rightValue;
      }

      const leftServe = left.bowlServeLatency.length ? Math.max.apply(null, left.bowlServeLatency) : 0;
      const rightServe = right.bowlServeLatency.length ? Math.max.apply(null, right.bowlServeLatency) : 0;
      if (leftServe !== rightServe) return leftServe - rightServe;

      const leftNames = left.bowlOrder.map(function (name) { return String(name).toLowerCase(); }).join("\u0000");
      const rightNames = right.bowlOrder.map(function (name) { return String(name).toLowerCase(); }).join("\u0000");
      if (leftNames < rightNames) return -1;
      if (leftNames > rightNames) return 1;
      return 0;
    })[0];
  }

  return { SECONDS: SECONDS, buildPlan: buildPlan };
}));