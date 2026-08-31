import React from "react";

const ProfileHeaderSkeleton = ({ isOwnProfile = false }) => {
  return (
    <div className="max-w-xl mx-auto px-4 pb-16">
      <section className="flex items-center justify-center pt-4">
        <div className="w-full">
          <div className="flex justify-between items-center">
            <div className="flex flex-col">
              <div className="flex items-center">
                <div className="h-7 w-36 bg-neutral-800 rounded-md animate-pulse" />
                <div className="ml-2 h-5 w-5 bg-neutral-800 rounded-full animate-pulse" />
              </div>
              <div className="h-4 w-28 bg-neutral-800 rounded mt-2.5 animate-pulse" />
            </div>
            <div className="ml-12">
              <div className="w-18 h-18 rounded-full border-2 border-neutral-800 bg-neutral-800 animate-pulse" />
            </div>
          </div>

          <div className="space-y-2 mt-3.5">
            <div className="h-4 w-5/6 bg-neutral-800 rounded animate-pulse" />
            <div className="h-4 w-3/5 bg-neutral-800 rounded animate-pulse" />
          </div>

          <div className="pt-4 flex items-center gap-2">
            <div className="flex -space-x-2">
              {[...Array(3)].map((_, i) => (
                <div
                  key={i}
                  className="w-5 h-5 rounded-full bg-neutral-800 border-2 border-neutral-950 animate-pulse"
                />
              ))}
            </div>
            <div className="h-4 w-24 bg-neutral-800 rounded animate-pulse" />
          </div>
        </div>
      </section>

      <div className="flex justify-center items-center gap-4 mt-2">
        {isOwnProfile ? (
          <div className="flex flex-row items-center justify-center gap-2 w-full mt-4">
            <div className="h-10 w-full bg-neutral-800 rounded-lg animate-pulse" />
            <div className="h-10 w-full bg-neutral-800 rounded-lg animate-pulse" />
          </div>
        ) : (
          <div className="flex flex-row items-center justify-center gap-2 w-full mt-4">
            <div className="h-10 w-full bg-neutral-800 rounded-lg animate-pulse" />
            <div className="h-10 w-full bg-neutral-800 rounded-lg animate-pulse" />
          </div>
        )}
      </div>

      <div className="mt-6 border-b border-neutral-800 pb-3 flex gap-8">
        <div className="h-5 w-16 bg-neutral-800 rounded animate-pulse" />
        <div className="h-5 w-16 bg-neutral-800 rounded animate-pulse" />
        <div className="h-5 w-16 bg-neutral-800 rounded animate-pulse" />
      </div>

      <div className="space-y-4 mt-6">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="p-4 rounded-xl border border-neutral-900 bg-neutral-900/40 space-y-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-neutral-800 animate-pulse" />
              <div className="space-y-1.5">
                <div className="h-4 w-24 bg-neutral-800 rounded animate-pulse" />
                <div className="h-3 w-16 bg-neutral-800 rounded animate-pulse" />
              </div>
            </div>
            <div className="h-4 w-full bg-neutral-800 rounded animate-pulse" />
            <div className="h-4 w-4/5 bg-neutral-800 rounded animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
};

export default ProfileHeaderSkeleton;
