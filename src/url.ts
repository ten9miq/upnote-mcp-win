export function getUpNoteUrlOpenerCommand(url: string, platform = process.platform): string[] {
  if (!url.startsWith("upnote://")) {
    throw new Error(`Refusing to open a non-UpNote URL: ${url}`);
  }

  if (platform === "darwin") {
    return ["open", url];
  }

  if (platform === "win32") {
    // rundll32 delegates the URL to the registered Windows scheme handler.
    // The URL is a separate process argument, not interpolated into a shell command.
    return ["rundll32.exe", "url.dll,FileProtocolHandler", url];
  }

  if (!Bun.which("xdg-open")) {
    throw new Error("xdg-open is required to open upnote:// URLs on Linux, but it was not found on PATH.");
  }
  return ["xdg-open", url];
}

export async function openUpNoteUrl(url: string): Promise<void> {
  const command = getUpNoteUrlOpenerCommand(url);
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "pipe" });
  const exitCode = await child.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(child.stderr).text();
    throw new Error(`Failed to open UpNote URL (exit code ${exitCode}): ${stderr.trim() || url}`);
  }
}
