import { DataSource, SessionId } from "@polaris/protocol";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { DataApi, SaveSourceInput } from "../data/api.ts";
import { openSourceForm } from "../model/sidebar.ts";
import { openTable } from "../model/store.ts";
import { fixtureDataApi } from "../preview/fixtureApi.ts";
import { FIXTURE_SOURCES } from "../preview/fixtures.ts";
import { DATA_AT } from "../preview/scene.ts";
import { click, found, mountData, page, type, useDataLayout } from "./data.testing.tsx";
import { saveErrorText } from "./sidebar/SourceForm.tsx";

useDataLayout();

/** Every `data.source.save` the form sent; `answer` replaces the fixture's reply. */
const saving = (api: DataApi, answer?: DataApi["saveSource"]) => {
  const saved: Array<SaveSourceInput> = [];

  return {
    saved,
    api: {
      ...api,
      saveSource: (at, input) => {
        saved.push(input);

        return (answer ?? api.saveSource)(at, input);
      },
    } satisfies DataApi,
  };
};

const form = () => page().getByTestId("data-source-form");

const field = (name: string) =>
  found(within(form()).getByText(name).parentElement?.querySelector("input"), name);

const fill = (values: Readonly<Record<string, string>>) => {
  for (const [name, value] of Object.entries(values)) type(field(name), value);
};

/** A paste into `input`; false when the form took it over (the event's default was prevented). */
const paste = (input: HTMLInputElement, text: string) => {
  let typed = false;

  act(() => {
    typed = fireEvent.paste(input, { clipboardData: { getData: () => text } });
  });

  return typed;
};

const submit = () =>
  act(async () => {
    fireEvent.submit(form());
  });

const openAdd = async () => click(await waitFor(() => page().getByTestId("data-add-source")));

const WAREHOUSE = { Name: "warehouse", Host: "warehouse.internal", Database: "dw", User: "reader" };

describe("Add data source", () => {
  test("posts the form, password included, and the new source joins the tree", async () => {
    const { api, saved } = saving(fixtureDataApi());

    mountData(api);
    await openAdd();
    fill({ ...WAREHOUSE, Password: "s3cret" });
    await submit();

    expect(saved).toEqual([
      {
        name: "warehouse",
        engine: "postgres",
        host: "warehouse.internal",
        port: 5432,
        database: "dw",
        user: "reader",
        password: "s3cret",
        label: { text: "", colour: "red" },
      },
    ]);
    await waitFor(() =>
      expect(
        page()
          .getAllByTestId("data-source-row")
          .map((r) => r.dataset.source)
      ).toContain("warehouse")
    );
    expect(page().queryByTestId("data-source-form")).toBeNull();
  });

  test("the typed password never reaches the DOM's attributes", async () => {
    mountData(fixtureDataApi());
    await openAdd();
    fill({ Password: "hunter2-SECRET" });

    expect(field("Password").value).toBe("hunter2-SECRET");
    expect(document.documentElement.outerHTML).not.toContain("hunter2-SECRET");
  });

  test.each([
    ["Billing DB", "Use only a–z, 0–9, “.”, “_” or “-”, starting with a letter or digit"],
    ["請求書", "Use only a–z, 0–9, “.”, “_” or “-”, starting with a letter or digit"],
    ["-x", "Use only a–z, 0–9, “.”, “_” or “-”, starting with a letter or digit"],
  ])("a name the Host refuses (%p) is caught in the form", async (name, problem) => {
    const { api, saved } = saving(fixtureDataApi());

    mountData(api);
    await openAdd();
    fill({ ...WAREHOUSE, Name: name });
    await submit();

    expect(saved).toEqual([]);
    expect(within(form()).getByRole("alert").textContent).toBe(problem);
  });

  test("a name in capitals is saved lowercased, and the form says so first", async () => {
    const { api, saved } = saving(fixtureDataApi());

    mountData(api);
    await openAdd();
    fill({ ...WAREHOUSE, Name: "Analytics2" });

    expect(within(form()).getByText("Saved as analytics2")).toBeTruthy();
    await submit();
    expect(saved.map((s) => s.name)).toEqual(["analytics2"]);
  });

  test("the label keeps what was typed and saves uppercased", async () => {
    const { api, saved } = saving(fixtureDataApi());

    mountData(api);
    await openAdd();
    fill({ ...WAREHOUSE, Label: "dw prod" });

    expect(field("Label").value).toBe("dw prod");
    await submit();
    expect(saved.map((s) => s.label)).toEqual([{ text: "DW PROD", colour: "red" }]);
  });

  test("a connection string pasted into Host fills the form, password and TLS included", async () => {
    const { api, saved } = saving(fixtureDataApi());

    mountData(api);
    await openAdd();
    fill({ Name: "shop" });
    paste(field("Host"), "mysql://reader:p%40ss@[::1]/orders?ssl-mode=REQUIRED");
    await submit();

    expect(saved).toEqual([
      {
        name: "shop",
        engine: "mysql",
        host: "::1",
        port: 3306,
        database: "orders",
        user: "reader",
        password: "p@ss",
        label: { text: "", colour: "red" },
        tls: "require",
      },
    ]);
  });

  test("a SQLite URL pasted into Host switches to SQLite with its file", async () => {
    mountData(fixtureDataApi());
    await openAdd();
    paste(field("Host"), "file:///srv/app/dev.db");

    expect(page().getByTestId<HTMLInputElement>("data-source-path").value).toBe("/srv/app/dev.db");
  });

  test("text that isn't a connection string pastes as typed", async () => {
    mountData(fixtureDataApi());
    await openAdd();

    expect(paste(field("Host"), "db.internal")).toBe(true);
    expect(field("Database").value).toBe("");
  });

  test("the Host's no-such-source answer reads as what the user did", async () => {
    const { api } = saving(fixtureDataApi(), async () => ({
      ok: false,
      error: {
        code: "E-DATA-UNKNOWN-SOURCE",
        message: "No data source by that name in this checkout.",
      },
    }));

    mountData(api);
    await openAdd();
    fill(WAREHOUSE);
    await submit();

    expect(within(form()).getByRole("alert").textContent).toBe(
      "The Host couldn't save it under that name. Use only a–z, 0–9, “.”, “_” or “-”, starting with a letter or digit, and check the host and database."
    );
  });

  test("the form is per agent session: one opened in another session isn't shown here", async () => {
    const other = { ...DATA_AT, sessionId: SessionId.make("s-another") };

    mountData(fixtureDataApi());
    await waitFor(() => page().getByTestId("data-add-source"));
    act(() => openSourceForm(other, { mode: "add" }));

    expect(page().queryByTestId("data-source-form")).toBeNull();
    act(() => openSourceForm(DATA_AT, { mode: "add" }));
    expect(page().getByTestId("data-source-form")).toBeTruthy();
  });
});

describe("Edit", () => {
  const manual = new DataSource({
    ...Schema.encodeSync(DataSource)(found(FIXTURE_SOURCES[1], "ledger")),
    id: "src-manual-warehouse",
    name: "warehouse",
    foundIn: { kind: "manual" },
  });

  test("Remove saved password saves with passwordAction clear and no password", async () => {
    const { api, saved } = saving(fixtureDataApi({ sources: [...FIXTURE_SOURCES, manual] }));

    mountData(api);
    act(() => openTable("warehouse", { schema: "public", name: "invoices" }, DATA_AT));
    click(await waitFor(() => page().getByTestId("data-connection-bar")));
    click(within(page().getByTestId("data-connection-card")).getByRole("button", { name: "Edit" }));
    click(page().getByTestId("data-source-clear-password"));

    expect(within(form()).getByText("Save removes the saved password.")).toBeTruthy();
    await submit();
    expect(
      saved.map(({ name, passwordAction, password }) => [name, passwordAction, password])
    ).toEqual([["warehouse", "clear", undefined]]);
  });
});

test.each([
  ["a name the Host can't match", "No data source by that name in this checkout.", true],
  ["a taken name", "A data source already uses that name.", false],
])("%s on save: the message the form shows", (_, message, editing) => {
  const text = saveErrorText({ code: "E-DATA-UNKNOWN-SOURCE", message }, editing);

  expect(text).toBe(
    editing
      ? "This data source is no longer in this checkout. Close the form and look again."
      : "A data source already uses that name."
  );
});
