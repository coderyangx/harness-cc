export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type Message =
  | { role: 'user'; content: string | JsonValue[] }
  | { role: 'assistant'; content: any };

export type ToolSchema = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type ToolHandler = (input: Record<string, any>) => Promise<string> | string;

export type BackgroundTask = {
  status: string;
  command: string;
  result: string | null;
};

export type TaskRecord = {
  id: number;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  owner?: string | null;
  worktree?: string;
  blockedBy?: number[];
  created_at?: number;
  updated_at?: number;
};

export type WorktreeRecord = {
  name: string;
  path: string;
  branch: string;
  task_id?: number | null;
  status: string;
  created_at?: number;
  removed_at?: number;
  kept_at?: number;
};
