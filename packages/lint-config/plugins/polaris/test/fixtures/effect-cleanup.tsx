import { useEffect, useLayoutEffect } from "react";
import * as React from "react";

declare const el: HTMLElement;
declare const subscribe: () => () => void;
declare const cancel: () => void;

export const Effects = () => {
  useEffect(() => el.scrollIntoView(), []);
  useLayoutEffect(() => el.focus(), []);
  React.useEffect(() => subscribe(), []);
  useEffect(async () => {
    await Promise.resolve();
  }, []);

  useEffect(() => {
    el.scrollIntoView();
  }, []);
  useEffect(() => {
    return subscribe();
  }, []);
  useEffect(() => () => cancel(), []);
  useEffect(() => cancel, []);
  useEffect(() => void el.focus(), []);

  return null;
};
