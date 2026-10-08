import { describe, expect, it } from "vitest";
import { gitProxyTarget } from "../server/git-proxy.ts";

describe("gitProxyTarget", () => {
  it("relays only git's smart HTTP endpoints on github.com", () => {
    expect(
      gitProxyTarget("github.com/ada/demo.git/info/refs", "GET", "?service=git-receive-pack"),
    ).toEqual({
      url: "https://github.com/ada/demo.git/info/refs?service=git-receive-pack",
      kind: "git",
    });
    expect(gitProxyTarget("github.com/ada/demo.git/git-receive-pack", "POST", "")).toEqual({
      url: "https://github.com/ada/demo.git/git-receive-pack",
      kind: "git",
    });
    expect(
      "error" in gitProxyTarget("github.com/ada/demo.git/info/refs", "POST", "?service=x"),
    ).toBe(true);
    expect("error" in gitProxyTarget("github.com/ada/demo.git/git-receive-pack", "GET", "")).toBe(
      true,
    );
    expect(
      "error" in gitProxyTarget("github.com/ada/demo.git/info/refs", "GET", "?service=foo"),
    ).toBe(true);
    expect(
      "error" in
        gitProxyTarget("github.com/ada/../x.git/info/refs", "GET", "?service=git-upload-pack"),
    ).toBe(true);
    expect(
      "error" in
        gitProxyTarget("gitlab.com/ada/demo.git/info/refs", "GET", "?service=git-upload-pack"),
    ).toBe(true);
    expect("error" in gitProxyTarget("github.com/ada/demo.git/HEAD", "GET", "")).toBe(true);
  });
  it("relays a job's log and nothing else on the API host", () => {
    expect(gitProxyTarget("api.github.com/repos/ada/demo/actions/jobs/42/logs", "GET", "")).toEqual(
      {
        url: "https://api.github.com/repos/ada/demo/actions/jobs/42/logs",
        kind: "logs",
      },
    );
    expect(
      "error" in gitProxyTarget("api.github.com/repos/ada/demo/actions/jobs/42/logs", "POST", ""),
    ).toBe(true);
    expect("error" in gitProxyTarget("api.github.com/user", "GET", "")).toBe(true);
    expect("error" in gitProxyTarget("api.github.com/repos/ada/demo", "GET", "")).toBe(true);
  });
});
