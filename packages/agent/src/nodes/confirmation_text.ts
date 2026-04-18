/**
 * User-facing confirmation message for HITL interrupts. Shared between the
 * tools node (where the interrupt is raised) and the graph parser (where the
 * pending confirmation is built for the API consumer).
 */
export function buildConfirmationMessage(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const filePath = typeof args.path === "string" ? args.path : "";
  switch (toolName) {
    case "write_file": {
      const content = typeof args.content === "string" ? args.content : "";
      const preview =
        content.length > 80 ? content.slice(0, 80) + "…" : content;
      return `Se creará el archivo: ${filePath}${preview ? ` (${preview})` : ""}`;
    }
    case "edit_file":
      return `Se editará el archivo: ${filePath} — reemplazando fragmento de texto`;
    case "bash": {
      const cmd =
        typeof args.prompt === "string" ? args.prompt : String(args.prompt ?? "");
      const preview = cmd.length > 120 ? cmd.slice(0, 120) + "…" : cmd;
      return `Se ejecutará comando: ${preview}`;
    }
    default:
      return `Confirmación requerida para ${toolName}`;
  }
}
