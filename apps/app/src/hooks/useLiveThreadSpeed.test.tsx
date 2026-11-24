// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useLiveThreadSpeed } from "./useLiveThreadSpeed";

const { mutateAsync } = vi.hoisted(() => ({ mutateAsync: vi.fn() }));

vi.mock("./mutations/thread-state-mutations", () => ({
  useUpdateThread: () => ({ mutateAsync }),
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("updates speed immediately and preserves the order of rapid switches", async () => {
  let finish: () => void = () => {};

  mutateAsync
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  const onChange = vi.fn();

  const { result } = renderHook(() =>
    useLiveThreadSpeed({ threadId: "thread-1", value: "default", onChange }),
  );

  act(() => result.current("fast"));
  expect(onChange).toHaveBeenLastCalledWith("fast");
  await waitFor(() =>
    expect(mutateAsync).toHaveBeenCalledExactlyOnceWith({
      id: "thread-1",
      serviceTier: "fast",
    }),
  );
  act(() => result.current("default"));
  expect(mutateAsync).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  await waitFor(() =>
    expect(mutateAsync).toHaveBeenLastCalledWith({
      id: "thread-1",
      serviceTier: "default",
    }),
  );
});

it("restores the selected speed after an update fails", async () => {
  mutateAsync.mockRejectedValue(new Error("Host disconnected"));
  const onChange = vi.fn();

  const { result } = renderHook(() =>
    useLiveThreadSpeed({ threadId: "thread-1", value: "default", onChange }),
  );

  act(() => result.current("fast"));
  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("default"));
});

it("keeps the last confirmed speed when a rapid later switch fails", async () => {
  let finish: () => void = () => {};

  mutateAsync
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    )
    .mockRejectedValueOnce(new Error("Disconnected"));

  const onChange = vi.fn();

  const { result } = renderHook(() =>
    useLiveThreadSpeed({ threadId: "thread-1", value: "default", onChange }),
  );

  act(() => {
    result.current("fast");
    result.current("ultrafast");
  });
  await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
  await act(async () => finish());
  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("fast"));
});
