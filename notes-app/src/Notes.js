import React, { useState, useMemo, useRef } from "react";
import { createApiClient } from "./apiClient";
import { supabase } from "./supabaseClient";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";

/**
 * Notes component
 *
 * Renders the user's notes and provides CRUD operations (create, read, update, delete).
 * Uses `@tanstack/react-query` for data fetching, caching, and optimistic updates.
 * Accessibility considerations: labels, ARIA live regions, keyboard handlers.
 */

/**
 * Fetch notes page
 * @param {{pageParam:number, api:import('axios').AxiosInstance}} options - pageParam and configured api client
 * @returns {Promise<Array>} an array of notes for the requested page
 */

async function fetchNotes({ pageParam = 0, api }) {
  if (!api) {
    throw new Error("Not authenticated");
  }
  const res = await api.get(`/notes`, {
    params: { limit: 10, offset: pageParam },
  });
  return res.data;
}

export default function Notes({ session }) {
  /*====================
    Local UI state
    ====================*/
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [noteStatus, setNoteStatus] = useState({});

  // Accessibility: visually hidden style for screen reader-only text
  const srOnly = { position: 'absolute', left: '-10000px', top: 'auto', width: '1px', height: '1px', overflow: 'hidden' };
  const [globalMessage, setGlobalMessage] = useState("");
  const titleRef = useRef(null);
  const clearGlobalMessage = (delay = 3000) => {
    setTimeout(() => setGlobalMessage(''), delay);
  };

  const setNoteState = (id, patch) =>
    setNoteStatus((prev) => ({ ...prev, [id]: { ...(prev?.[id] || {}), ...patch } }));

  /**
   * Remove per-note transient state
   * @param {string|number} id - note id
   */
  const clearNoteState = (id) =>
    setNoteStatus((prev) => {
      if (!prev || !prev[id]) return prev;
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });

  const queryClient = useQueryClient();

  /**
   * Refresh function used by the API client to obtain a new access token.
   * Replace this with a more explicit refresh call if your auth provider exposes one.
   * @returns {Promise<string|null>} new access token or null on failure
   */
  const refreshFn = async () => {
    try {
      // Attempt to get an up-to-date session from Supabase
      const { data } = await supabase.auth.getSession();
      const newToken = data?.session?.access_token;
      return newToken || null;
    } catch (err) {
      return null;
    }
  }; 

  const api = useMemo(() => createApiClient(session?.access_token, { refreshToken: refreshFn }), [session?.access_token]);

  /*====================
    READ - useQuery
    ====================*/
  const {
    data,
    isLoading,
    isError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["notes", session?.user?.id],
    queryFn: ({ pageParam = 0 }) => fetchNotes({ pageParam, api }),
    enabled: !!session?.access_token,
    getNextPageParam: (lastPage, allPages) => {
      if (!Array.isArray(lastPage)) return undefined;
      if (lastPage.length < 10) return undefined;
      return allPages.length * 10;
    },
  });

  /*====================
    CREATE - useMutation
    ====================*/
  const addNoteMutation = useMutation({
    mutationFn: async ({ title, content }) => {
      const res = await api.post(`/notes`, { title, content });
      return res.data;
    },

    // Optimistic update: add a temporary note immediately
    onMutate: async (newNote) => {
      await queryClient.cancelQueries({ queryKey: ["notes", session?.user?.id] });
      const previous = queryClient.getQueryData(["notes", session?.user?.id]);
      const tempId = `temp-${Date.now()}`;

      queryClient.setQueryData(["notes", session?.user?.id], (old) => {
        if (!old) return old;
        const pages = old.pages ? old.pages.map((p) => p.slice()) : [];
        if (pages.length === 0) pages.unshift([]);
        pages[0].unshift({ id: tempId, title: newNote.title, content: newNote.content });
        return { ...old, pages };
      });

      // track per-note UI state for this optimistic note
      setNoteState(tempId, { adding: true, error: null });
      return { previous, tempId };
    },

    // Rollback on error and surface accessible message
    onError: (err, newNote, context) => {
      if (context?.tempId) setNoteState(context.tempId, { adding: false, error: err?.message || 'Add failed' });
      setGlobalMessage(`Error adding note: ${err?.message || 'Add failed'}`);
      clearGlobalMessage();
      queryClient.setQueryData(["notes", session?.user?.id], context.previous);
    },

    // Replace temporary note with server-provided note on success
    onSuccess: (data, _vars, context) => {
      if (context?.tempId && data) {
        queryClient.setQueryData(["notes", session?.user?.id], (old) => {
          if (!old) return old;
          const pages = old.pages.map((p) => p.map((n) => (n.id === context.tempId ? data : n)));
          return { ...old, pages };
        });
        clearNoteState(context.tempId);
        setGlobalMessage('Note added');
        clearGlobalMessage();
        // focus title input for keyboard users
        if (titleRef.current) titleRef.current.focus();
      }
    },

    // Always ensure query is fresh after mutation settles
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["notes", session?.user?.id] });
    },
  });

  function addNote() {
    if (!newTitle.trim()) return;

    addNoteMutation.mutate({ title: newTitle, content: newContent });

    setNewTitle("");
    setNewContent("");
  }

  /*====================
    DELETE - useMutation
    ====================*/
  const deleteNoteMutation = useMutation({
    mutationFn: async (id) => {
      const res = await api.delete(`/notes/${id}`);
      return res.data;
    },
    onMutate: async (id) => {
      setNoteState(id, { deleting: true, error: null });
      await queryClient.cancelQueries({ queryKey: ["notes", session?.user?.id] });
      const previous = queryClient.getQueryData(["notes", session?.user?.id]);
      queryClient.setQueryData(["notes", session?.user?.id], (old) => {
        if (!old) return old;
        const pages = old.pages.map((p) => p.filter((n) => n.id !== id));
        return { ...old, pages };
      });
      return { previous };
    },
    onError: (err, id, context) => {
      setNoteState(id, { deleting: false, error: err?.message || "Delete failed" });
      queryClient.setQueryData(["notes", session?.user?.id], context.previous);
    },
    onSettled: (_data, _error, id) => {
      clearNoteState(id);
      queryClient.invalidateQueries({ queryKey: ["notes", session?.user?.id] });
    },
  });

  /*====================
    UPDATE - useMutation
    ====================*/
  const updateNoteMutation = useMutation({
    mutationFn: async ({ id, title, content }) => {
      const res = await api.put(`/notes/${id}`, { title, content });
      return res.data;
    },
    onMutate: async (updated) => {
      await queryClient.cancelQueries({ queryKey: ["notes", session?.user?.id] });
      const previous = queryClient.getQueryData(["notes", session?.user?.id]);
      queryClient.setQueryData(["notes", session?.user?.id], (old) => {
        if (!old) return old;
        const pages = old.pages.map((p) => p.map((n) => (n.id === updated.id ? { ...n, title: updated.title, content: updated.content } : n)));
        return { ...old, pages };
      });
      return { previous };
    },
    onError: (err, updated, context) => {
      queryClient.setQueryData(["notes", session?.user?.id], context.previous);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["notes", session?.user?.id] });
    },
  });

  function startEdit(note) {
    setEditingId(note.id);
    setEditTitle(note.title);
    setEditContent(note.content || "");
  }

  function cancelEdit() {
    setEditingId(null);
    setEditTitle("");
    setEditContent("");
  }

  function saveEdit(id) {
    if (!editTitle.trim()) return;

    updateNoteMutation.mutate({ id, title: editTitle, content: editContent });

    cancelEdit();
  }

  /*====================
    Render
    ====================*/
  if (!session?.access_token) return <p>Please log in to view notes.</p>;
  if (isLoading) return <p>Loading...</p>;
  if (isError) return <p>Error loading notes.</p>;
  // Guard against undefined pages and use optional chaining
  const notes = data?.pages?.flat() ?? [];
  return (
    <div style={{ maxWidth: 600, margin: "2rem auto" }}>
      <h2>Your Notes</h2>

      <form aria-labelledby="add-note-heading" onSubmit={(e) => { e.preventDefault(); addNote(); }} style={{ marginBottom: "1rem" }}>
        <h3 id="add-note-heading" style={{ margin: '0 0 .5rem 0' }}>Add a note</h3>
        <label htmlFor="new-note-title" style={{ display: 'block' }}>
          <span style={srOnly}>Title</span>
          <input
            id="new-note-title"
            ref={titleRef}
            aria-label="Title"
            placeholder="Title"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            required
          />
        </label>
        <label htmlFor="new-note-content" style={{ display: 'block' }}>
          <span style={srOnly}>Content</span>
          <input
            id="new-note-content"
            aria-label="Content"
            placeholder="Content"
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
          />
        </label>
        <button type="submit" disabled={addNoteMutation.isLoading}>{addNoteMutation.isLoading ? 'Adding...' : 'Add'}</button>
        {addNoteMutation.isError && <p role="alert" style={{ color: 'red' }}>Error adding note: {addNoteMutation.error?.message}</p>}
        <div id="notes-global-status" role="status" aria-live="polite" style={srOnly}>{globalMessage}</div>
      </form>

      {/* Notes List */}
      <section aria-labelledby="notes-heading">
        <h2 id="notes-heading" style={{ display: 'none' }}>Your Notes</h2>
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {notes.map((note) => {
            const status = noteStatus[note.id] || {};
            return (
              <li key={note.id} style={{ border: '1px solid #ccc', padding: '1rem', marginBottom: '.5rem' }}>
                {editingId === note.id ? (
                  <>
                    <input
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(note.id); if (e.key === 'Escape') cancelEdit(); }}
                      aria-label={`Edit title for ${note.title}`}
                    />
                    <input
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(note.id); if (e.key === 'Escape') cancelEdit(); }}
                      aria-label={`Edit content for ${note.title}`}
                    />
                    <button onClick={() => saveEdit(note.id)} disabled={status.updating} aria-label={`Save changes to ${note.title}`}>{status.updating ? 'Saving...' : 'Save'}</button>
                    <button onClick={cancelEdit} disabled={status.updating} aria-label={`Cancel editing ${note.title}`}>Cancel</button>
                    {status.error && <p role="alert" style={{ color: 'red' }}>{status.error}</p>}
                  </>
                ) : (
                  <>
                    <strong>{note.title}{status.adding && <em style={{ marginLeft: 8, color: '#666' }}>(Saving...)</em>}</strong>
                    <p>{note.content}</p>
                    <button onClick={() => startEdit(note)} disabled={status.updating || status.deleting} aria-label={`Edit ${note.title}`}>Edit</button>
                    <button onClick={() => deleteNoteMutation.mutate(note.id)} disabled={status.deleting} aria-label={`Delete ${note.title}`}>{status.deleting ? 'Deleting...' : 'Delete'}</button>
                    {status.error && <p role="alert" style={{ color: 'red' }}>{status.error}</p>}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </section>
      {hasNextPage && (
        <button onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
          {isFetchingNextPage ? "Loading more..." : "Load More Notes"}
        </button>
      )}
    </div>
  );
}