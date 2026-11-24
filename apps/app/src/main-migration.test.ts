// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = "";
  delete document.documentElement.dataset.omnyoStorageMigrationError;
  Reflect.deleteProperty(window, "__omnyoBrowserStorageAdmission");
  vi.resetModules();
});

it("imports browser preferences and starts the app without recovery", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Reflect.set(window, "__omnyoBrowserStorageAdmission", Promise.resolve());
  const appEntry = vi.fn();
  vi.doMock("./app-entry", () => {
    appEntry();

    return {};
  });
  localStorage.setItem("bb.sidebar.width", "280");
  localStorage.setItem("omnyo.sidebar.width", "360");
  localStorage.setItem("bb.sidebar.open", "not a flag");

  await import("./main");

  await vi.waitFor(() => expect(appEntry).toHaveBeenCalled());
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(localStorage.getItem("omnyo.sidebar.width")).toBe("360");
  expect(localStorage.getItem("bb.sidebar.width")).toBeNull();
  expect(localStorage.getItem("bb.sidebar.open")).toBeNull();
  vi.doUnmock("./app-entry");
});

it("shows recovery before importing app startup when pending state conflicts", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Reflect.set(window, "__omnyoBrowserStorageAdmission", Promise.resolve());

  const legacy = JSON.stringify([
    { id: "pending_one", projectId: "project-one", realThreadId: "thread-one" },
  ]);

  const canonical = JSON.stringify([
    { id: "pending_one", projectId: "project-one", realThreadId: "thread-two" },
  ]);

  sessionStorage.setItem("bb.pending-chats.v1", legacy);
  sessionStorage.setItem("omnyo.pending-chats.v1", canonical);
  const localBefore = Object.entries(localStorage);
  const sessionBefore = Object.entries(sessionStorage);
  const fetch = vi.spyOn(globalThis, "fetch");

  try {
    await import("./main");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Saved browser data needs review",
    );
    expect(document.querySelector("button")?.textContent).toBe("Reload");
    expect(fetch).not.toHaveBeenCalled();
    expect(Object.entries(localStorage)).toEqual(localBefore);
    expect(Object.entries(sessionStorage)).toEqual(sessionBefore);
    expect(sessionStorage.getItem("bb.pending-chats.v1")).toBe(legacy);
    expect(sessionStorage.getItem("omnyo.pending-chats.v1")).toBe(canonical);
  } finally {
    fetch.mockRestore();
  }
});
