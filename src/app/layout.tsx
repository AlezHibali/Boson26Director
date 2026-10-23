import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "AI Director Studio · Director Desk",
  description:
    "Voice-native film studio · Manual staging, editable actors and Boson capability lab",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
