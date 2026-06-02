/** Resolved shell used by the bash tool. */
export function getShellCommand(): { cmd: string; args: string[] } {
  if (Deno.build.os === "windows") {
    return { cmd: "cmd.exe", args: ["/c"] };
  }
  try {
    const shell = Deno.env.get("SHELL");
    if (shell) {
      const name = shell.split("/").pop() ?? "sh";
      if (name === "bash" || name === "zsh" || name === "sh") {
        return { cmd: shell, args: ["-c"] };
      }
    }
  } catch {
    // Deno.env may be unavailable under restricted permissions.
  }
  return { cmd: "/bin/sh", args: ["-c"] };
}
