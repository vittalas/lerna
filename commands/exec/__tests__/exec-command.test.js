"use strict";

const execa = require("execa");
const fs = require("fs-extra");
const path = require("path");

// mocked modules
const ChildProcessUtilities = require("@lerna/child-process");

// helpers
const initFixture = require("@lerna-test/init-fixture")(__dirname);
const loggingOutput = require("@lerna-test/logging-output");
const normalizeRelativeDir = require("@lerna-test/normalize-relative-dir");

// file under test
const lernaExec = require("@lerna-test/command-runner")(require("../command"));

// assertion helpers
const calledInPackages = () =>
  ChildProcessUtilities.spawn.mock.calls.map(([, , opts]) => path.basename(opts.cwd));

const execInPackagesStreaming = testDir =>
  ChildProcessUtilities.spawnStreaming.mock.calls.reduce((arr, [command, params, opts]) => {
    const dir = normalizeRelativeDir(testDir, opts.cwd);
    arr.push([dir, command].concat(params).join(" "));
    return arr;
  }, []);

describe("ExecCommand", () => {
  // TODO: it's very suspicious that mockResolvedValue() doesn't work here
  ChildProcessUtilities.spawn = jest.fn(() => Promise.resolve());
  ChildProcessUtilities.spawnStreaming = jest.fn(() => Promise.resolve());

  describe("in a basic repo", () => {
    it("should complain if invoked without command", async () => {
      expect.assertions(1);

      const testDir = await initFixture("basic");

      try {
        await lernaExec(testDir)("--parallel");
      } catch (err) {
        expect(err.message).toBe("A command to execute is required");
      }
    });

    it("rejects with execution error", async () => {
      expect.assertions(1);

      const testDir = await initFixture("basic");

      ChildProcessUtilities.spawn.mockImplementationOnce(() => {
        const boom = new Error("execa error");
        boom.code = 1;
        boom.cmd = "boom";

        throw boom;
      });

      try {
        await lernaExec(testDir)("boom");
      } catch (err) {
        expect(err.message).toBe("execa error");
      }
    });

    it("should ignore execution errors with --bail=false", async () => {
      const testDir = await initFixture("basic");

      await lernaExec(testDir)("boom", "--no-bail");

      expect(ChildProcessUtilities.spawn).toHaveBeenCalledTimes(2);
      expect(ChildProcessUtilities.spawn).lastCalledWith(
        "boom",
        [],
        expect.objectContaining({
          reject: false,
        })
      );
    });

    it("should filter packages with `ignore`", async () => {
      const testDir = await initFixture("basic");

      await lernaExec(testDir)("ls", "--ignore", "package-1");

      expect(ChildProcessUtilities.spawn).toHaveBeenCalledTimes(1);
      expect(ChildProcessUtilities.spawn).lastCalledWith("ls", [], {
        cwd: path.join(testDir, "packages/package-2"),
        env: expect.objectContaining({
          LERNA_PACKAGE_NAME: "package-2",
        }),
        reject: true,
        shell: true,
      });
    });

    it("should filter packages that are not updated with --since", async () => {
      const testDir = await initFixture("basic");
      const file1 = path.join(testDir, "packages/package-1", "file-1.js");
      const file2 = path.join(testDir, "packages/package-2", "file-2.js");

      // make change
      await fs.appendFile(file2, "// package-2");
      await execa("git", ["add", file2], { cwd: testDir });
      await execa("git", ["commit", "-m", "skip change"], { cwd: testDir });

      // tag a release
      await execa("git", ["tag", "-m", "v1.0.1", "v1.0.1"], { cwd: testDir });

      // make another change
      await fs.appendFile(file1, "// package-1");
      await execa("git", ["add", file1], { cwd: testDir });
      await execa("git", ["commit", "-m", "show change"], { cwd: testDir });

      await lernaExec(testDir)("ls", "--since");

      expect(ChildProcessUtilities.spawn).toHaveBeenCalledTimes(1);
      expect(ChildProcessUtilities.spawn).lastCalledWith("ls", [], {
        cwd: path.join(testDir, "packages/package-1"),
        env: expect.objectContaining({
          LERNA_PACKAGE_NAME: "package-1",
        }),
        reject: true,
        shell: true,
      });
    });

    it("requires a git repo when using --since", async () => {
      expect.assertions(1);

      const testDir = await initFixture("basic");

      await fs.remove(path.join(testDir, ".git"));

      try {
        await lernaExec(testDir)("ls", "--since", "some-branch");
      } catch (err) {
        expect(err.message).toMatch("this is not a git repository");
      }
    });

    it("should run a command", async () => {
      const testDir = await initFixture("basic");

      await lernaExec(testDir)("ls");

      expect(ChildProcessUtilities.spawn).toHaveBeenCalledTimes(2);
      expect(calledInPackages()).toEqual(["package-1", "package-2"]);
    });

    it("should run a command with parameters", async () => {
      const testDir = await initFixture("basic");

      await lernaExec(testDir)("ls", "--", "-la");

      expect(ChildProcessUtilities.spawn).toHaveBeenCalledTimes(2);
      expect(ChildProcessUtilities.spawn).lastCalledWith("ls", ["-la"], expect.any(Object));
    });

    it("runs a command for a given scope", async () => {
      const testDir = await initFixture("basic");

      await lernaExec(testDir)("ls", "--scope", "package-1");

      expect(calledInPackages()).toEqual(["package-1"]);
    });

    it("does not run a command for ignored packages", async () => {
      const testDir = await initFixture("basic");

      await lernaExec(testDir)("ls", "--ignore", "package-@(2|3|4)");

      expect(calledInPackages()).toEqual(["package-1"]);
    });

    it("executes a command in all packages with --parallel", async () => {
      const testDir = await initFixture("basic");

      await lernaExec(testDir)("--parallel", "ls");

      expect(execInPackagesStreaming(testDir)).toEqual(["packages/package-1 ls", "packages/package-2 ls"]);
    });

    it("executes a command in all packages with --stream", async () => {
      const testDir = await initFixture("basic");

      await lernaExec(testDir)("--stream", "ls");

      expect(execInPackagesStreaming(testDir)).toEqual(["packages/package-1 ls", "packages/package-2 ls"]);
    });
  });

  describe("in a cyclical repo", () => {
    it("warns when cycles are encountered", async () => {
      const testDir = await initFixture("toposort");

      await lernaExec(testDir)("ls");

      const [logMessage] = loggingOutput("warn");
      expect(logMessage).toMatch("Dependency cycles detected, you should fix these!");
      expect(logMessage).toMatch("package-cycle-1 -> package-cycle-2 -> package-cycle-1");
      expect(logMessage).toMatch("package-cycle-2 -> package-cycle-1 -> package-cycle-2");
      expect(logMessage).toMatch(
        "package-cycle-extraneous -> package-cycle-1 -> package-cycle-2 -> package-cycle-1"
      );

      expect(calledInPackages()).toEqual([
        "package-dag-1",
        "package-standalone",
        "package-dag-2a",
        "package-dag-2b",
        "package-dag-3",
        "package-cycle-1",
        "package-cycle-2",
        "package-cycle-extraneous",
      ]);
    });

    it("should throw an error with --reject-cycles", async () => {
      expect.assertions(1);

      const testDir = await initFixture("toposort");

      try {
        await lernaExec(testDir)("ls", "--reject-cycles");
      } catch (err) {
        expect(err.message).toMatch("Dependency cycles detected, you should fix these!");
      }
    });
  });
});
