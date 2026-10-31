/**
 * Every `#data/<scene>`: each lane's scenes live in their own file here and join this map, so a
 * new scene is a new key, never an edit to another lane's.
 */
import type { DataScene } from "./scene.ts";
import { SQL_SCENES } from "./sql.ts";
import { TABLE_SCENES } from "./table.ts";

const ALL = {
  ...TABLE_SCENES,
  ...SQL_SCENES,
} satisfies Record<string, DataScene>;

const SCENES: ReadonlyMap<string, DataScene> = new Map(Object.entries(ALL));

export const sceneNamed = (name: string): DataScene | undefined => SCENES.get(name);

export type { DataScene } from "./scene.ts";
