import "@dsh-orb/native-selection";
//#region src/orb.d.ts
/** Host services the plugin injects. Shapes match the official 0.1.7-rc.2 controllers. */
interface OrbContext {
  readonly webServer: {
    readonly port: number;
    register(route: {
      kind: 'prefix';
      path: string;
      handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>;
    }): () => void;
  };
  readonly connection: {
    authenticatedUrl(baseUrl: string): string;
    admit?(request: import('node:http').IncomingMessage): {
      rejection?: number;
    } | {
      peer?: unknown;
    };
    isAuthenticated?(request: import('node:http').IncomingMessage): boolean;
  };
  readonly workspaceController: {
    create(request: {
      readonly path: string;
    }): Promise<{
      readonly workspace: {
        readonly workspaceId: string;
      };
    }>;
  };
  readonly sessionController: {
    create(request: {
      readonly workspaceId?: string;
      readonly sessionId?: string;
      readonly agentPreset?: string;
    }): Promise<{
      readonly sessionId: string;
    }>;
    /**
     * Resolve or resume one existing Session: the live Agent when it is already attached, otherwise
     * the resumed one. This — not `create` — is how a stored conversation is opened. Since dsh
     * 0.2.1 `create` reuses a named Session only while it is still blank and otherwise mints a
     * different one, the same contract both versions already carry for `resolveAgent`.
     */
    resolveAgent(sessionId: string): Promise<{
      readonly agent: unknown;
    } | {
      readonly error: unknown;
    }>;
    prompt(request: {
      readonly requestId: string;
      readonly sessionId: string;
      readonly mode: 'queue' | 'steer';
      readonly content: readonly {
        readonly type: 'text';
        readonly text: string;
      }[];
      readonly clientTimeZone?: string;
    }, signal: AbortSignal): Promise<{
      readonly accepted: true;
    }>;
    list(request: object, signal: AbortSignal): Promise<{
      readonly items?: readonly unknown[];
    } | readonly unknown[]>;
    selectModel(request: {
      readonly sessionId: string;
      readonly provider: string;
      readonly model: string;
      readonly reasoningEffort?: string;
    }): Promise<unknown>;
    cancel(request: {
      readonly sessionId: string;
    }): Promise<unknown>;
    modelCatalog(): unknown;
  };
  readonly sessions: {
    get(id: string): {
      snapshotEvents(): readonly {
        readonly type: string;
        readonly seq: number;
        readonly data: unknown;
      }[];
      readonly header?: {
        readonly cwd?: string;
        readonly agentPreset?: string;
      };
    } | undefined;
  };
  readonly agentDefaultModel?: {
    currentSelection(): {
      readonly provider: string;
      readonly model: string;
      readonly reasoningEffort?: string;
    };
    saveSelection(selection: {
      readonly provider: string;
      readonly model: string;
      readonly reasoningEffort?: string;
    }): Promise<void>;
  };
  effect(execute: () => void | (() => void)): void;
  get(name: string): unknown;
  provide(name: string, value: unknown): void;
  on(name: 'user-questions/request', listener: (request: QuestionRequest, next: () => Promise<QuestionAnswer>) => Promise<QuestionAnswer>, options?: {
    readonly prepend?: boolean;
  }): (() => void) | void;
  on(name: 'session/created', listener: (session: {
    readonly header?: {
      readonly cwd?: string;
      readonly agentPreset?: string;
    };
  }) => void): (() => void) | void;
  on(name: 'agent/assistant-stream', listener: (payload: {
    readonly agent?: {
      readonly session?: {
        readonly id?: unknown;
      };
    };
    readonly frame?: unknown;
  }) => void, options?: {
    readonly global?: boolean;
  }): (() => void) | void;
  on(name: 'settings/document-updated', listener: (ns: unknown, revision: unknown) => void): (() => void) | void;
  on(name: string, listener: (...args: unknown[]) => void): (() => void) | void;
}
interface QuestionRequest {
  readonly questions?: unknown;
  readonly agent?: {
    readonly id?: unknown;
  };
  readonly signal?: AbortSignal;
}
interface QuestionAnswer {
  readonly answers: readonly {
    readonly id: string;
    readonly selected: readonly string[];
    readonly custom?: string;
  }[];
}
//#endregion
//#region src/index.d.ts
/** Cordis plugin name. */
declare const name = "orb-host";
/** Official services this plugin reads. Missing ones keep it pending. */
declare const inject: string[];
/**
 * Register preferences, Computer Use services, and settings routes, then start the ball.
 * Linux never starts the helper. `autoStart: false` and `ball-enabled.json` leave Computer Use in the main window.
 * @param ctx - host services named in {@link inject}.
 * @param config - patch config. `autoStart: false` skips the helper until settings turn it back on.
 */
declare function apply(ctx: OrbContext, config?: {
  autoStart?: boolean;
}): void;
//#endregion
export { type OrbContext, apply, inject, name };