import { describe, expect, test } from "bun:test";
import { TOUCH, touchTracker } from "./gesture.ts";

/** A pointer at CSS pixel (x, y) on a 400×800 screen at the origin. */
const at = (x: number, y: number) => ({ point: { x: x / 400, y: y / 800 }, client: { x, y } });

const plan = (messages: ReadonlyArray<{ type: string; x: number; y: number; at: number }>) =>
  messages.map((m) => `${m.type} ${Math.round(m.x * 400)},${Math.round(m.y * 800)} @${m.at}`);

describe("touchTracker", () => {
  test("a click is a begin and an end at the same place, the end at the click's own time", () => {
    const touch = touchTracker();

    expect(plan([...touch.down(at(100, 200), 1000), ...touch.up(at(100, 200), 1080)])).toEqual([
      "begin 100,200 @1000",
      "end 100,200 @1080",
    ]);
  });

  test("a trackpad tap shorter than the minimum hold is held to it", () => {
    const touch = touchTracker();

    touch.down(at(10, 10), 1000);
    expect(plan(touch.up(at(10, 10), 1003))).toEqual([`end 10,10 @${1000 + TOUCH.minHoldMs}`]);
  });

  test("a long press keeps the user's hold, so iOS sees a long press", () => {
    const touch = touchTracker();

    touch.down(at(50, 50), 0);
    expect(plan(touch.up(at(50, 50), 1200))).toEqual(["end 50,50 @1200"]);
  });

  test("a wobble within the slop sends no move and ends the tap where it began", () => {
    const touch = touchTracker();

    touch.down(at(100, 100), 0);
    expect(touch.move(at(103, 104), 20)).toEqual([]);
    expect(plan(touch.up(at(104, 103), 60))).toEqual(["end 100,100 @60"]);
  });

  test("a swipe moves once past the slop, then on every move, and ends where the finger left", () => {
    const touch = touchTracker();

    expect(
      plan([
        ...touch.down(at(200, 700), 0),
        ...touch.move(at(200, 600), 30),
        ...touch.move(at(200, 300), 60),
        ...touch.up(at(200, 100), 90),
      ])
    ).toEqual(["begin 200,700 @0", "move 200,600 @30", "move 200,300 @60", "end 200,100 @90"]);
  });

  test("once moved, a small move still goes out: the slop is only for the start", () => {
    const touch = touchTracker();

    touch.down(at(0, 0), 0);
    touch.move(at(0, 20), 10);
    expect(plan(touch.move(at(0, 21), 20))).toEqual(["move 0,21 @20"]);
  });

  test("moves and ups without a down send nothing", () => {
    const touch = touchTracker();

    expect(touch.move(at(1, 1), 0)).toEqual([]);
    expect(touch.up(at(1, 1), 0)).toEqual([]);
    expect(touch.cancel(0)).toEqual([]);
  });

  test("a lost pointer ends the touch where it last was, once", () => {
    const touch = touchTracker();

    touch.down(at(10, 10), 0);
    touch.move(at(10, 90), 100);
    expect(plan(touch.cancel(200))).toEqual(["end 10,90 @200"]);
    expect(touch.active()).toBe(false);
    expect(touch.up(at(10, 90), 300)).toEqual([]);
  });

  test("a down while a touch is open ends that touch before beginning the next", () => {
    const touch = touchTracker();

    touch.down(at(10, 10), 0);
    expect(plan(touch.down(at(300, 300), 500))).toEqual(["end 10,10 @500", "begin 300,300 @500"]);
  });
});
