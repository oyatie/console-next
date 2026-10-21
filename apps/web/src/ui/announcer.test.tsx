// SPDX-License-Identifier: LicenseRef-Proprietary
// oxlint-disable-next-line no-restricted-imports -- Component test mounts Announcer inside a memory router.
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { announce, bindAnnouncer } from "../lib/react/announce";
import { Announcer } from "./announcer";

const hooks = vi.hoisted(() => ({
  active: false,
  states: [] as unknown[],
  stateIdx: 0,
  effects: [] as { deps: readonly unknown[] | undefined; cleanup?: (() => void) | void }[],
  effectIdx: 0,
  pendingEffects: [] as (() => void)[],
  reset() {
    for (const eff of this.effects) {
      if (typeof eff?.cleanup === "function") eff.cleanup();
    }
    this.states = [];
    this.stateIdx = 0;
    this.effects = [];
    this.effectIdx = 0;
    this.pendingEffects = [];
  },
}));

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: <T,>(initial: T | (() => T)) => {
      if (!hooks.active) return actual.useState(initial);
      const idx = hooks.stateIdx++;
      if (!(idx in hooks.states)) {
        hooks.states[idx] = typeof initial === "function" ? (initial as () => T)() : initial;
      }
      const set = (next: T | ((prev: T) => T)) => {
        const prev = hooks.states[idx] as T;
        hooks.states[idx] = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      };
      return [hooks.states[idx] as T, set] as const;
    },
    useEffect: (fn: () => (() => void) | void, deps?: readonly unknown[]) => {
      if (!hooks.active) return actual.useEffect(fn, deps);
      const idx = hooks.effectIdx++;
      const prev = hooks.effects[idx];
      const changed = !prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, i) => !Object.is(d, prev.deps![i]));
      if (changed) {
        hooks.pendingEffects.push(() => {
          if (typeof prev?.cleanup === "function") prev.cleanup();
          const cleanup = fn();
          hooks.effects[idx] = { deps, cleanup };
        });
      }
    },
  };
});

function harness(initialPath = "/access") {
  let queue: FrameRequestCallback[] = [];
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("self", globalThis);
  vi.stubGlobal("document", {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelector: () => null,
  });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => queue.push(cb));
  const frame = () => {
    const run = queue;
    queue = [];
    run.forEach((cb) => cb(0));
  };
  const root = createRootRoute();
  const access = createRoute({ getParentRoute: () => root, path: "/access" });
  const org = createRoute({ getParentRoute: () => root, path: "/org" });
  const people = createRoute({ getParentRoute: () => root, path: "/people/" });
  const person = createRoute({ getParentRoute: () => root, path: "/people/$id" });
  const router = createRouter({
    routeTree: root.addChildren([access, org, people, person]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  const render = () => {
    let html = "";
    for (let pass = 0; pass < 3; pass++) {
      hooks.stateIdx = 0;
      hooks.effectIdx = 0;
      hooks.pendingEffects = [];
      hooks.active = true;
      try {
        html = renderToStaticMarkup(
          <RouterContextProvider router={router}>
            <Announcer bind={bindAnnouncer} />
          </RouterContextProvider>,
        );
      } finally {
        hooks.active = false;
      }
      if (hooks.pendingEffects.length === 0) break;
      const toRun = hooks.pendingEffects;
      hooks.pendingEffects = [];
      toRun.forEach((run) => run());
    }
    return html;
  };
  return { router, render, frame };
}

beforeEach(() => hooks.reset());
afterEach(() => {
  hooks.reset();
  vi.unstubAllGlobals();
});

test("clears the live region when navigating to a different pathname", async () => {
  const { router, render, frame } = harness("/access");
  await router.load();
  render();

  announce("「모의 조회 역할」 역할을 저장했습니다");
  frame();
  expect(render()).toBe('<div role="status" class="sr-only">「모의 조회 역할」 역할을 저장했습니다</div>');

  await router.navigate({ to: "/org" });
  expect(router.state.location.pathname).toBe("/org");
  expect(render()).toBe('<div role="status" class="sr-only"></div>');
});

test("speaks an announcement made after navigation, and preserves cancel-sheet navigate-then-announce in the same task", async () => {
  const { router, render, frame } = harness("/people/emp-1");
  await router.load();
  render();

  // Cancel-sheet order: navigate({ to: "/people" }) in onSuccess, then announce(...) in the same task.
  const nav = router.navigate({ to: "/people" });
  announce("정하늘의 등록을 취소했습니다");
  await nav;
  expect(router.state.location.pathname).toBe("/people");
  frame();
  expect(render()).toBe('<div role="status" class="sr-only">정하늘의 등록을 취소했습니다</div>');

  // Announcement made after navigation has already settled on the new page.
  await router.navigate({ to: "/org" });
  expect(router.state.location.pathname).toBe("/org");
  expect(render()).toBe('<div role="status" class="sr-only"></div>');
  announce("조직 변경을 저장했습니다");
  frame();
  expect(render()).toBe('<div role="status" class="sr-only">조직 변경을 저장했습니다</div>');
});

test("does not clear a fresh announcement on a search-param-only change on the same pathname", async () => {
  const { router, render, frame } = harness("/org?sel=a");
  await router.load();
  render();

  announce("변경 내용을 저장했습니다");
  frame();
  expect(render()).toBe('<div role="status" class="sr-only">변경 내용을 저장했습니다</div>');

  await router.navigate({ to: "/org", search: { sel: "b" } as never });
  expect(router.state.location.href).toBe("/org?sel=b");
  expect(render()).toBe('<div role="status" class="sr-only">변경 내용을 저장했습니다</div>');
});

test("announcing the same text twice in a row clears first and then re-announces on the next frame", async () => {
  const { router, render, frame } = harness("/access");
  await router.load();
  render();

  announce("코드를 복사했습니다");
  frame();
  expect(render()).toBe('<div role="status" class="sr-only">코드를 복사했습니다</div>');

  announce("코드를 복사했습니다");
  expect(render()).toBe('<div role="status" class="sr-only"></div>');
  frame();
  expect(render()).toBe('<div role="status" class="sr-only">코드를 복사했습니다</div>');
});
