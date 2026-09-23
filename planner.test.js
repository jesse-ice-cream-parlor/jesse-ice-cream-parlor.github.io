"use strict";

const assert = require("node:assert/strict");
const { buildPlan, SECONDS } = require("./planner.js");

assert.deepEqual(SECONDS, { remove: 1, scoop: 1, replace: 1, deliver: 1 });

const flavors = [
  { id: "vanilla", name: "Vanilla" },
  { id: "chocolate", name: "Chocolate" }
];
const orders = [
  { name: "Alice", scoops: { vanilla: 1, chocolate: 1 } },
  { name: "Bob", scoops: { vanilla: 1, chocolate: 0 } }
];
const plan = buildPlan(flavors, orders);

assert.deepEqual(plan.bowlOrder, ["Bob", "Alice"]);
assert.equal(plan.maximumExposure, 5);
assert.equal(plan.maximumBowlWait, 6);

const stringPlan = buildPlan(flavors, [
  { name: "Casey", scoops: { vanilla: "some", chocolate: "" } }
]);
assert.deepEqual(stringPlan.bowlOrder, ["Casey"]);
assert.equal(stringPlan.events.find(function (event) {
  return event.action === "Scoop some Vanilla for Casey";
}).duration, SECONDS.scoop);

assert.deepEqual(plan.events.map(function (event) { return event.action; }), [
  "Take out Vanilla",
  "Scoop 1 Vanilla for Bob",
  "Deliver bowl to Bob",
  "Scoop 1 Vanilla for Alice",
  "Put away Vanilla",
  "Take out Chocolate",
  "Scoop 1 Chocolate for Alice",
  "Put away Chocolate",
  "Deliver bowl to Alice"
]);

assert.equal(buildPlan(flavors, []).events.length, 0);

console.log("Planner tests passed.");