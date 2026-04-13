import type { ToolRisk } from "./index";

export interface ToolUIMetadata {
  id: string;
  name: string;
  description: string;
  risk: ToolRisk;
  requiresIntegration: string | null;
}

export const TOOL_UI_METADATA: ToolUIMetadata[] = [
  {
    id: "get_user_preferences",
    name: "Preferencias del usuario",
    description: "Consulta tu configuración y preferencias.",
    risk: "low",
    requiresIntegration: null,
  },
  {
    id: "list_enabled_tools",
    name: "Listar herramientas",
    description: "Muestra qué herramientas tienes habilitadas.",
    risk: "low",
    requiresIntegration: null,
  },
  {
    id: "github_list_repos",
    name: "GitHub: listar repos",
    description: "Lista tus repositorios de GitHub.",
    risk: "low",
    requiresIntegration: "github",
  },
  {
    id: "github_list_issues",
    name: "GitHub: listar issues",
    description: "Lista issues de un repositorio.",
    risk: "low",
    requiresIntegration: "github",
  },
  {
    id: "github_create_issue",
    name: "GitHub: crear issue",
    description: "Crea un issue nuevo (requiere confirmación).",
    risk: "medium",
    requiresIntegration: "github",
  },
  {
    id: "github_create_repo",
    name: "GitHub: crear repositorio",
    description: "Crea un repositorio nuevo (requiere confirmación).",
    risk: "medium",
    requiresIntegration: "github",
  },
  {
    id: "gmail_list_today_emails",
    name: "Gmail: emails de hoy",
    description: "Lista los correos recibidos hoy en tu Gmail.",
    risk: "low",
    requiresIntegration: "google",
  },
  {
    id: "web_search",
    name: "Buscar en la web",
    description: "Busca información actual en internet sobre cualquier tema.",
    risk: "low",
    requiresIntegration: null,
  },
  {
    id: "bash",
    name: "Terminal: ejecutar comando",
    description:
      "Ejecuta un comando de shell en el servidor (requiere confirmación).",
    risk: "high",
    requiresIntegration: null,
  },
];

export const RISK_LABELS: Record<ToolRisk, { text: string; color: string }> = {
  low: {
    text: "Bajo",
    color:
      "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  },
  medium: {
    text: "Medio",
    color:
      "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
  },
  high: {
    text: "Alto",
    color: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  },
};
