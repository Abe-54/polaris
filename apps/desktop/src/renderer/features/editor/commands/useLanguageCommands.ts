/**
 * The Editor's language commands (spec §6) for the focused file: restart its
 * server (⌥⌘R) or every server in the Workspace, Trust, the TypeScript version,
 * the language server log and Format document. Registered while the pane is mounted.
 */
import * as P from "@polaris/protocol";
import { Schema } from "effect";
import { useEffect } from "react";
import type { HostView } from "../../../../shared/api.ts";
import { languageIpcError } from "../../../../shared/languageError.ts";
import type { CommandRegistry } from "../../../routes/commands.ts";
import { hostInSentence } from "../../../shell/hostCopy.ts";
import { useCommands, useConnection } from "../../../shell/hooks.ts";
import type { Connection } from "../../../store/store.ts";
import { polaris } from "../../bridge.ts";
import { canOpenLanguageLog, openLanguageLog } from "../intents/languageLog.ts";
import { languageStore } from "../lsp/state.ts";
import { fileKey } from "../model/drafts.ts";
import { LANGUAGE_NAMES } from "../model/language.ts";
import { canFormatFile } from "../formatting/bridge.ts";
import { formatBuffer } from "../runtime/buffers.ts";
import { changeTrust } from "../trust/decide.ts";
import { trustFailure } from "../trust/model.ts";
import { trustOfFile } from "../trust/store.ts";
import { showOpenFailure } from "../ui/toasts.ts";
import { type FocusedFile, fileContext, trustFollowUp, typescriptFollowUp } from "./model.ts";
import {
  failedFollowUp,
  interpreterFollowUp,
  interpreterSummary,
  LOOKING,
} from "../python/model.ts";
import {
  interpretersOf,
  refreshInterpreters,
  selectInterpreter,
  type PythonTarget,
} from "../python/store.ts";
import { statusStore } from "../status/store.ts";
import {
  type Dialect,
  dialectFollowUp,
  dialectSummary,
  failedFollowUp as sqlFailedFollowUp,
  LOOKING as SQL_LOOKING,
} from "../sql/model.ts";
import { dialectOf, refreshDialect, selectDialect, type SqlTarget } from "../sql/store.ts";
import { languageFailure } from "./copy.ts";

type TrustAction = typeof P.LanguageTrustAction.Type;

interface Pane {
  readonly hostKey: string;
  readonly workspaceId: string;
  readonly active: string | null;
}

const decodeWorkspaceId = Schema.decodeUnknownSync(P.WorkspaceId);

const asLanguageError = (cause: unknown) =>
  Schema.is(P.LanguageError)(cause)
    ? cause
    : new P.LanguageError({ reason: "not-ready", message: String(cause), retryable: true });

const languageCommands = (commands: CommandRegistry, connection: Connection, pane: Pane) => {
  const { hostKey, workspaceId, active } = pane;
  const key = active === null ? null : fileKey(hostKey, active);
  const app = () => connection.store.getState();
  const host = (): HostView | undefined => app().hosts.find((h) => h.key === hostKey);

  const workspace = () =>
    app().hostModels[hostKey]?.workspaces.get(workspaceId)?.name ?? "this workspace";

  const focused = (): FocusedFile | null => {
    if (key === null || active === null) return null;
    const state = languageStore.getState().files[key];

    if (state === undefined) return null;

    return {
      path: active,
      language: state.language,
      providers: state.providers,
      status: trustOfFile(key)?.status ?? null,
      workspace: workspace(),
      canFormat: canFormatFile({ hostKey, workspaceId, path: active }),
      canShowLog: canOpenLanguageLog(),
      hasCheckout: checkoutTarget() !== null,
      pythonInterpreter: interpreterSummary(interpretersOf(key)),
      sqlDialect: dialectSummary(dialectOf(key), workspace()),
    };
  };

  const trusted = () => (key === null ? null : trustOfFile(key));

  /** The focused file and its checkout, for the Host-side Python and SQL choices. */
  const checkoutTarget = (): PythonTarget | null => {
    const checkout = key === null ? null : (statusStore.getState().files[key]?.checkout ?? null);

    return key === null || active === null || checkout === null
      ? null
      : { key, hostKey, checkout, path: active };
  };

  const interpreterChoice = (target: PythonTarget) => {
    const choose = (interpreter: string | null, revision: number) =>
      void selectInterpreter(target, interpreter, revision).catch((cause) =>
        fail("Couldn't select the interpreter", cause)
      );

    return {
      ...LOOKING,
      load: () =>
        refreshInterpreters(target)
          .then((list) => interpreterFollowUp(list, hostInSentence(host()), choose))
          .catch((cause) =>
            failedFollowUp(languageFailure(asLanguageError(cause), hostInSentence(host())))
          ),
    };
  };

  const dialectChoice = (target: SqlTarget) => {
    const choose = (dialect: Dialect | null, revision: number) =>
      void selectDialect(target, dialect, revision).catch((cause) =>
        fail("Couldn't select the dialect", cause)
      );

    return {
      ...SQL_LOOKING,
      load: () =>
        refreshDialect(target)
          .then((state) => dialectFollowUp(state, workspace(), choose))
          .catch((cause) =>
            sqlFailedFollowUp(languageFailure(asLanguageError(cause), hostInSentence(host())))
          ),
    };
  };

  const fail = (title: string, cause: unknown, message = languageFailure) =>
    showOpenFailure({ title, message: message(asLanguageError(cause), hostInSentence(host())) });

  const change = (action: TrustAction) => {
    const api = polaris().languages;
    const current = trusted();

    if (api === undefined || current === null) return;
    changeTrust(api, current.target, action, current.status.trust.revision).catch((cause) =>
      fail("Couldn't change trust", cause, trustFailure)
    );
  };

  const restart = () => {
    const api = polaris().languages;
    const file = focused();
    const current = trusted();

    if (api === undefined || file === null || current === null) return;

    for (const providerId of file.providers) {
      void api
        .request("languages.server.restart", {
          hostKey,
          checkout: current.target.checkout,
          providerId,
        })
        .then((result) => {
          if (!result.ok) throw languageIpcError(result.error);
        })
        .catch((cause) =>
          fail(`Couldn't restart the ${LANGUAGE_NAMES[file.language]} server`, cause)
        );
    }
  };

  const restartAll = () => {
    const api = polaris().languages;

    if (api === undefined) return;
    void api
      .request("languages.workspace.restart", {
        hostKey,
        workspaceId: decodeWorkspaceId(workspaceId),
      })
      .then((result) => {
        if (!result.ok) throw languageIpcError(result.error);
      })
      .catch((cause) => fail("Couldn't restart the language servers", cause));
  };

  const removeContext = commands.provide(() => fileContext(focused()));

  const removeHandlers = commands.register({
    "language.restart": {
      run: restart,
      enabled: () => (focused()?.providers.length ?? 0) > 0 && trusted() !== null,
    },
    "language.restartAll": {
      run: restartAll,
      enabled: () => polaris().languages !== undefined,
    },
    "editor.format": {
      run: () => {
        if (key === null || active === null) return;
        formatBuffer(key).catch((cause: unknown) =>
          showOpenFailure({
            title: `Couldn't format ${active.split("/").pop() ?? active}`,
            message: cause instanceof Error ? cause.message : String(cause),
          })
        );
      },
    },
    "language.showLog": {
      run: () => {
        const file = focused();
        const current = trusted();

        if (file === null || current === null) return;
        openLanguageLog({
          hostKey,
          workspaceId,
          checkout: current.target.checkout,
          language: file.language,
          providerId: file.providers[0] ?? null,
          path: file.path,
        });
      },
    },
    "typescript.selectVersion": {
      followUp: () => {
        const current = trusted();

        return current === null ? null : typescriptFollowUp(current.status, workspace(), change);
      },
    },
    "python.selectInterpreter": {
      followUp: () => {
        const target = checkoutTarget();

        return target === null ? null : interpreterChoice(target);
      },
    },
    "sql.selectDialect": {
      followUp: () => {
        const target = checkoutTarget();

        return target === null ? null : dialectChoice(target);
      },
    },
    "trust.grant": {
      followUp: () => {
        const current = trusted();

        return current === null
          ? null
          : trustFollowUp(current.status, workspace(), hostInSentence(host()), change);
      },
    },
    "trust.revoke": { run: () => change("revoke") },
    "trust.askAgain": { run: () => change("ask-again") },
  });

  return () => {
    removeContext();
    removeHandlers();
  };
};

export const useLanguageCommands = (
  hostKey: string,
  workspaceId: string,
  active: string | null
) => {
  const commands = useCommands();
  const connection = useConnection();

  useEffect(() => {
    return languageCommands(commands, connection, { hostKey, workspaceId, active });
  }, [commands, connection, hostKey, workspaceId, active]);
};
