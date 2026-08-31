import { Server } from "@hocuspocus/server";
import * as Y from "yjs";
import { config } from "./config";
import { pool, WORKSPACE_ID } from "./db";
import { verifyDemoIdentity, type DemoIdentity } from "./identity";
import { persistCollaborationDocument, storedCollaborationDocument } from "./collaboration-document";

interface CollaborationContext {
  identity: DemoIdentity;
  draftId: string;
  matterId: string;
}

function draftIdFor(documentName: string): string | null {
  const match = /^draft:([0-9a-f-]{36})$/i.exec(documentName);
  return match?.[1] ?? null;
}

export function createCollaborationServer(): Server<CollaborationContext> {
  return new Server<CollaborationContext>({
    name: "steno-collaboration",
    port: config.collaborationPort,
    address: "127.0.0.1",
    quiet: true,
    debounce: 250,
    maxDebounce: 1_000,
    async onAuthenticate({ documentName, token }) {
      const identity = verifyDemoIdentity(token);
      const draftId = draftIdFor(documentName);
      if (!identity || !draftId) throw new Error("Not authorized for this collaborative draft.");
      const result = await pool.query<{ matter_id: string; workspace_id: string }>(`
        SELECT d.matter_id, m.workspace_id
        FROM drafts d JOIN matters m ON m.id = d.matter_id
        WHERE d.id = $1
      `, [draftId]);
      const draft = result.rows[0];
      if (!draft || draft.workspace_id !== WORKSPACE_ID) throw new Error("Collaborative draft not found.");
      return { identity, draftId, matterId: draft.matter_id };
    },
    async onLoadDocument({ documentName }) {
      const draftId = draftIdFor(documentName);
      return draftId ? await storedCollaborationDocument(draftId) ?? new Y.Doc() : new Y.Doc();
    },
    async onStoreDocument({ documentName, document, lastContext }) {
      const draftId = draftIdFor(documentName);
      if (!draftId) return;
      const lookup = await pool.query<{ matter_id: string }>("SELECT matter_id FROM drafts WHERE id = $1", [draftId]);
      const matterId = lookup.rows[0]?.matter_id;
      if (!matterId) return;
      const snapshotVersion = await persistCollaborationDocument(draftId, document);
      const identity = lastContext?.identity;
      if (identity) {
        await pool.query(`
          INSERT INTO activity_events (workspace_id, matter_id, actor_id, event_type, summary, metadata)
          VALUES ($1, $2, $3, 'collaboration.edited', $4, $5)
        `, [
          WORKSPACE_ID,
          matterId,
          identity.id,
          `${identity.name} edited the collaborative draft`,
          JSON.stringify({ draftId, snapshotVersion }),
        ]);
      }
    },
  });
}
