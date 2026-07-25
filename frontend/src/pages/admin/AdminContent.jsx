import { useCallback, useEffect, useState } from "react";
import { toast } from "react-hot-toast";
import { adminAPI } from "../../services/api";
import {
  Panel,
  Spinner,
  ErrorState,
  EmptyState,
  Badge,
  Button,
  SearchInput,
  Select,
  Pagination,
  TableWrap,
  Th,
  Td,
  UserCell,
  relativeTime,
} from "../../components/admin/ui";

const AdminContent = () => {
  const [type, setType] = useState("post");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("recent");
  const [reportedOnly, setReportedOnly] = useState("false");
  const [page, setPage] = useState(1);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(
        await adminAPI.listContent({ type, search, sort, reportedOnly, page, limit: 25 })
      );
    } catch {
      setError("Couldn't load content.");
    } finally {
      setLoading(false);
    }
  }, [type, search, sort, reportedOnly, page]);

  useEffect(() => {
    const id = setTimeout(load, 250);
    return () => clearTimeout(id);
  }, [load]);

  const remove = async (item) => {
    const reason = window.prompt(
      "Why is this being removed? (recorded in the audit log)"
    );
    if (reason === null) return;

    setBusyId(item._id);
    try {
      await adminAPI.removeContent(type, item._id, reason);
      toast.success(`${type === "post" ? "Post" : "Comment"} removed`);
      await load();
    } catch (e) {
      toast.error(e.response?.data?.error || "Couldn't remove that");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-2xl font-bold">Content</h1>
        <p className="text-[13px] text-neutral-500 mt-1">
          {data ? `${data.pageInfo.total.toLocaleString()} items` : "Loading…"}
        </p>
      </header>

      <Panel>
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <SearchInput
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(1);
            }}
            placeholder="Search text…"
          />
          <Select
            value={type}
            onChange={(v) => {
              setType(v);
              setPage(1);
            }}
            options={[
              { value: "post", label: "Posts" },
              { value: "comment", label: "Comments" },
            ]}
          />
          <Select
            value={reportedOnly}
            onChange={(v) => {
              setReportedOnly(v);
              setPage(1);
            }}
            options={[
              { value: "false", label: "All content" },
              { value: "true", label: "Reported only" },
            ]}
          />
          <Select
            value={sort}
            onChange={setSort}
            options={[
              { value: "recent", label: "Newest" },
              { value: "oldest", label: "Oldest" },
              { value: "likes", label: "Most liked" },
              { value: "replies", label: "Most replies" },
            ]}
          />
        </div>

        {loading && !data ? (
          <Spinner />
        ) : error ? (
          <ErrorState message={error} onRetry={load} />
        ) : !data?.items.length ? (
          <EmptyState title="Nothing matches" hint="Try a different search or filter." />
        ) : (
          <>
            <TableWrap>
              <thead>
                <tr className="border-b border-neutral-800">
                  <Th>Content</Th>
                  <Th>Author</Th>
                  <Th className="text-right">Likes</Th>
                  <Th className="text-right">Replies</Th>
                  <Th className="text-right">Reports</Th>
                  <Th>Posted</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item._id} className="border-b border-neutral-900 hover:bg-neutral-900/50">
                    <Td>
                      <div className="max-w-[320px]">
                        <p className="truncate text-neutral-200">
                          {item.content || (
                            <span className="text-neutral-600">
                              {item.media?.length ? "Media only" : "Empty"}
                            </span>
                          )}
                        </p>
                        <div className="flex items-center gap-1.5 mt-1">
                          {item.media?.length > 0 && (
                            <Badge tone="neutral">{item.media.length} media</Badge>
                          )}
                          {item.isEdited && <Badge tone="neutral">edited</Badge>}
                          {item.isAiGenerated && <Badge tone="purple">AI</Badge>}
                        </div>
                      </div>
                    </Td>
                    <Td>
                      <UserCell user={item.author} />
                    </Td>
                    <Td className="text-right tabular-nums">{item.counts?.likes ?? 0}</Td>
                    <Td className="text-right tabular-nums">{item.counts?.replies ?? 0}</Td>
                    <Td className="text-right">
                      {item.reportCount > 0 ? (
                        <Badge tone={item.reportCount >= 5 ? "red" : "amber"}>
                          {item.reportCount}
                        </Badge>
                      ) : (
                        <span className="text-neutral-700">0</span>
                      )}
                    </Td>
                    <Td className="text-neutral-500 text-[12px]">
                      {relativeTime(item.createdAt)}
                    </Td>
                    <Td>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busyId === item._id}
                        onClick={() => remove(item)}
                      >
                        Remove
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <Pagination pageInfo={data.pageInfo} onPage={setPage} />
          </>
        )}
      </Panel>
    </div>
  );
};

export default AdminContent;
