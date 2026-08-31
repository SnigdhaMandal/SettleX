import * as fs from "fs";
import * as path from "path";

describe("Supabase Function search_path Security Lint (Issue #50)", () => {
  it("pins search_path on settlex_wallet and every function in supabase-setup.sql", () => {
    const setupSqlPath = path.resolve(__dirname, "../../supabase-setup.sql");
    const sqlContent = fs.readFileSync(setupSqlPath, "utf8");

    // Extract all function definitions
    const funcChunks = sqlContent.split(/CREATE OR REPLACE FUNCTION/i).slice(1);

    expect(funcChunks.length).toBeGreaterThan(0);

    const missingSearchPath: string[] = [];

    for (const chunk of funcChunks) {
      // Isolate the function header before function body begins
      const header = chunk.split(/\$\$|\$body\$/i)[0];
      const nameMatch = header.match(/^\s*([a-zA-Z0-9_\.]+)/);
      const funcName = nameMatch ? nameMatch[1] : "unknown";

      const hasSearchPath = /search_path\s*=/i.test(header);
      if (!hasSearchPath) {
        missingSearchPath.push(funcName);
      }
    }

    expect(missingSearchPath).toEqual([]);
  });

  it("verifies settlex_wallet specifically sets search_path = '' and fully qualifies catalog functions", () => {
    const setupSqlPath = path.resolve(__dirname, "../../supabase-setup.sql");
    const sqlContent = fs.readFileSync(setupSqlPath, "utf8");

    // Match settlex_wallet definition
    const settlexWalletMatch = sqlContent.match(
      /CREATE OR REPLACE FUNCTION public\.settlex_wallet\(\)[\s\S]*?\$\$/i
    );

    expect(settlexWalletMatch).not.toBeNull();
    const header = settlexWalletMatch![0];
    expect(header).toMatch(/SET\s+search_path\s*=\s*''/i);
  });
});
