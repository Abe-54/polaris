import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";

import { Horizon } from "./index";

afterEach(cleanup);

test("the horizon draws Moonlit's moon unless told not to", () => {
  const withMoon = render(<Horizon />);

  expect(withMoon.container.querySelector('[data-slot="horizon-moon"]')).not.toBeNull();
  cleanup();

  const without = render(<Horizon moon={false} />);

  expect(without.container.querySelector('[data-slot="horizon"]')).not.toBeNull();
  expect(without.container.querySelector('[data-slot="horizon-moon"]')).toBeNull();
});
