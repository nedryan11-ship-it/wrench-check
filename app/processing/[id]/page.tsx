"use client";

import { useEffect } from "react";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { Search } from "lucide-react";

export default function ProcessingPage() {
  const router = useRouter();
  const { id } = useParams();
  const searchParams = useSearchParams();
  const isPartial = searchParams.get("partial") === "true";

  useEffect(() => {
    const timer = setTimeout(() => {
      const dest = isPartial ? `/audit/${id}?partial=true` : `/audit/${id}`;
      router.push(dest);
    }, 1200);

    return () => clearTimeout(timer);
  }, [id, router, isPartial]);

  return (
    <div className="min-h-screen bg-[#F8F9FF] font-sans selection:bg-[#00236F]/10 flex flex-col items-center justify-center p-4">
       <div className="absolute inset-0 z-0 opacity-5 pointer-events-none bg-[radial-gradient(#00236F_1px,transparent_1px)] [background-size:24px_24px]" />
       
       <div className="w-24 h-24 mb-8 bg-white rounded-3xl flex items-center justify-center shadow-[0_20px_40px_rgba(13,28,46,0.06)] border border-[#C5C5D3]/20 relative z-10">
          <Search className="w-8 h-8 text-[#00236F]" />
          <div className="absolute inset-0 rounded-3xl border-2 border-t-[#00236F] border-r-transparent border-b-transparent border-l-transparent animate-spin" />
       </div>
       
       <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-2 text-center z-10">
          <h3 className="text-2xl font-black text-[#0D1C2E] uppercase tracking-tighter">
             Analyzing your estimate...
          </h3>
       </motion.div>
    </div>
  );
}
