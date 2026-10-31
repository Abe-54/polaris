import { DataSource } from "@polaris/protocol";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, setSystemTime, test } from "bun:test";
import { Schema } from "effect";
import type { DataApi } from "../data/api.ts";
import { openSqlTab, openTable } from "../model/store.ts";
import { fixtureDataApi } from "../preview/fixtureApi.ts";
import { FIXTURE_SOURCES } from "../preview/fixtures.ts";
import { DATA_AT } from "../preview/scene.ts";
import {
  click,
  found,
  inputOf,
  mountData,
  page,
  refreshTime,
  type,
  useDataLayout,
} from "./data.testing.tsx";

useDataLayout();

const fields = Schema.encodeSync(DataSource);

const decode = Schema.decodeUnknownSync(DataSource);

/** As IPC delivers them: every snapshot decodes fresh objects, labels too, equal in value. */
const fresh = (sources: ReadonlyArray<DataSource>) =>
  sources.map((s) => decode(JSON.parse(JSON.stringify(fields(s)))));

/** Labels posted through the card, as `[source, label]`. */
const posting = (api: DataApi) => {
  const posted: Array<unknown> = [];

  return {
    posted,
    api: {
      ...api,
      labelSource: (at, source, label) => {
        posted.push([source, label]);

        return api.labelSource(at, source, label);
      },
    } satisfies DataApi,
  };
};

/** Runs `act` a day after the last refresh, past refreshSources' once-a-second throttle. */
const later = (act: () => void) => {
  setSystemTime(new Date(refreshTime()));
  act();
  setSystemTime();
};

const bar = () => page().getByTestId("data-connection-bar");

const openCard = async () => {
  click(await waitFor(() => bar()));

  return inputOf(page().getByTestId("data-label-field"));
};

describe("the connection bar", () => {
  test("a label colour from its card posts data.source.label and re-tints the bar", async () => {
    const { api, posted } = posting(fixtureDataApi());

    mountData(api);
    act(() => openTable("ledger", "invoices", DATA_AT));

    expect((await waitFor(() => bar())).dataset.colour).toBe("tan");
    click(bar());
    await act(async () => {
      fireEvent.click(page().getByRole("radio", { name: "Blue" }));
    });

    expect(posted).toEqual([["ledger", { text: "PLANETSCALE · OVERDUE-TOTALS", colour: "blue" }]]);
    await waitFor(() => expect(bar().dataset.colour).toBe("blue"));
  });

  test.each([
    ["the window regains focus", () => window.dispatchEvent(new Event("focus"))],
    ["its card opens", () => click(bar())],
  ])(
    "when %s the sources are re-listed, and the bar shows them as they are now",
    async (_, act) => {
      const down = FIXTURE_SOURCES.map((s) =>
        s.name === "app" ? new DataSource({ ...fields(s), reachable: false, error: "gone" }) : s
      );

      let gone = false;

      mountData(fixtureDataApi({ relist: () => (gone ? down : FIXTURE_SOURCES) }));
      const access = () => page().getByTestId("data-connection-access").textContent;

      await waitFor(() => expect(access()).toBe("Agents read · writes ask you"));
      gone = true;
      later(act);

      await waitFor(() => expect(access()).toBe("Can't reach it"));
    }
  );

  test("the label posts on Enter, uppercased, and the field keeps what was typed", async () => {
    const { api, posted } = posting(fixtureDataApi());

    mountData(api);
    const field = await openCard();

    type(field, "dev box");
    // Rewriting the value to upper case would move the caret to the end on every keystroke.
    expect(field.value).toBe("dev box");
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });

    expect(posted).toEqual([["app", { text: "DEV BOX", colour: "none" }]]);
    await waitFor(() =>
      expect(page().getByTestId("data-connection-kicker").textContent).toBe("DEV BOX")
    );
  });

  test("Escape closes the card and still posts the label being typed", async () => {
    const { api, posted } = posting(fixtureDataApi());

    mountData(api);
    const field = await openCard();

    type(field, "staging-esc");
    await act(async () => {
      fireEvent.keyDown(field, { key: "Escape" });
    });

    expect(page().queryByTestId("data-connection-card")).toBeNull();
    expect(posted).toEqual([["app", { text: "STAGING-ESC", colour: "none" }]]);
    await waitFor(() =>
      expect(page().getByTestId("data-connection-kicker").textContent).toBe("STAGING-ESC")
    );
  });

  test("a snapshot landing while the user types leaves the field alone", async () => {
    const api = fixtureDataApi({ relist: () => fresh(FIXTURE_SOURCES) });
    let opened = false;
    let relisted: () => void = () => undefined;

    const landed = new Promise<void>((resolve) => {
      relisted = resolve;
    });

    mountData({
      ...api,
      watchSources: (at, on) =>
        api.watchSources(at, {
          ...on,
          next: (sources) => {
            on.next(sources);

            if (opened) relisted();
          },
        }),
    });
    await waitFor(() => bar());
    // Opening the card re-lists: its snapshot lands after the user has started typing.
    later(() => click(bar()));
    opened = true;
    const field = inputOf(page().getByTestId("data-label-field"));

    type(field, "pro");
    await waitFor(() => landed);

    expect(field.value).toBe("pro");
  });

  test("a tab on a source that isn't listed says so, and never names another source", async () => {
    mountData(fixtureDataApi());
    await waitFor(() => bar());
    act(() => openTable("warehouse-old", "page_views", DATA_AT));

    await waitFor(() => expect(bar().dataset.gone).toBe(""));
    expect(bar().textContent).toBe("NOT IN THIS CHECKOUTwarehouse-oldIts data source is gone");
    act(() => openSqlTab("select count(*) from page_views", "warehouse-old", DATA_AT));
    expect(page().getByTestId("data-connection-access").textContent).toBe(
      "Choose a data source in the run bar"
    );
  });

  test("on a narrow bar the access keeps a short form, never in the label's colour", async () => {
    mountData(fixtureDataApi());
    act(() => openTable("analytics", "events", DATA_AT));

    await waitFor(() => expect(bar().dataset.colour).toBe("red"));
    const short = page().getByTestId("data-connection-access-short");
    const access = found(short.parentElement, "access");

    expect([short.textContent, access.title]).toEqual([
      "Not approved",
      "Agents can't reach it until you approve it",
    ]);
    // rule/data-source-label: the label colours the kicker and the ground, never approval state.
    expect(access.className).not.toContain("severity-critical");
    expect(page().getByTestId("data-connection-kicker").title).toBe("PRODUCTION");
  });

  test("the bar's table name reads in its own direction", async () => {
    mountData(fixtureDataApi());
    act(() => openTable("app", "الفواتير_المتأخرة", DATA_AT));

    const where = await waitFor(() => page().getByTestId("data-connection-where"));

    expect(within(where).getByText("الفواتير_المتأخرة").getAttribute("dir")).toBe("auto");
  });
});

describe("a source the user added", () => {
  const manual = new DataSource({
    ...fields(found(FIXTURE_SOURCES[1], "ledger")),
    id: "src-manual-warehouse",
    name: "warehouse",
    foundIn: { kind: "manual" },
  });

  const mountManual = () => {
    const api = fixtureDataApi({ sources: [...FIXTURE_SOURCES, manual] });
    const removed: Array<string> = [];

    mountData({
      ...api,
      removeSource: (at, name) => {
        removed.push(name);

        return api.removeSource(at, name);
      },
    });
    act(() => openTable("warehouse", "invoices", DATA_AT));

    return removed;
  };

  const rows = () =>
    page()
      .getAllByTestId("data-source-row")
      .map((r) => r.dataset.source);

  test("Remove asks in place, Cancel keeps it, and confirming removes it from the tree", async () => {
    const removed = mountManual();

    await openCard();
    click(page().getByTestId("data-source-remove"));
    const card = page().getByTestId("data-connection-card");

    expect(within(card).getByText(/can't query/).textContent).toBe(
      "Agents in this checkout can't query warehouse after this, and its saved password is deleted. You can add it again."
    );
    expect(document.activeElement?.textContent).toBe("Cancel");
    click(within(card).getByRole("button", { name: "Cancel" }));
    expect(removed).toEqual([]);

    click(page().getByTestId("data-source-remove"));
    await act(async () => {
      fireEvent.click(page().getByTestId("data-source-remove-confirm"));
    });

    expect(removed).toEqual(["warehouse"]);
    await waitFor(() => expect(rows()).toEqual(["app", "ledger", "analytics"]));
    expect(page().queryByTestId("data-connection-card")).toBeNull();
  });
});
