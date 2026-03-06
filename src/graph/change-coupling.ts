import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface ChangeCoupling {
  fileA: string;
  fileB: string;
  strength: number;
  coChangeCount: number;
  totalCommitsA: number;
  totalCommitsB: number;
}

export interface FileChangeHistory {
  filePath: string;
  commitCount: number;
  lastModified: Date;
  authors: string[];
}

export interface ChangeCouplingResult {
  couplings: ChangeCoupling[];
  fileHistories: Map<string, FileChangeHistory>;
  topCoupledFiles: Map<string, string[]>;
}

export function detectChangeCoupling(
  repoPath: string,
  options: {
    maxCommits?: number;
    minCoChangeCount?: number;
    since?: string;
    includePatterns?: string[];
  } = {}
): ChangeCouplingResult {
  const {
    maxCommits = 500,
    minCoChangeCount = 2,
    since = '6 months ago',
    includePatterns = ['.ts', '.tsx', '.js', '.jsx', '.py'],
  } = options;

  if (!isGitRepo(repoPath)) {
    return { couplings: [], fileHistories: new Map(), topCoupledFiles: new Map() };
  }

  const commits = getCommitHistory(repoPath, maxCommits, since);
  const coChangeCounts = new Map<string, Map<string, number>>();
  const fileCommitCounts = new Map<string, number>();
  const fileAuthors = new Map<string, Set<string>>();
  const fileLastModified = new Map<string, Date>();

  for (const commit of commits) {
    const changedFiles = getCommitFiles(repoPath, commit.hash);

    const relevantFiles = changedFiles.filter(f =>
      includePatterns.some(ext => f.endsWith(ext))
    );

    for (const file of relevantFiles) {
      fileCommitCounts.set(file, (fileCommitCounts.get(file) || 0) + 1);

      if (!fileAuthors.has(file)) {
        fileAuthors.set(file, new Set());
      }
      fileAuthors.get(file)!.add(commit.author);

      const commitDate = new Date(commit.date);
      const currentLast = fileLastModified.get(file);
      if (!currentLast || commitDate > currentLast) {
        fileLastModified.set(file, commitDate);
      }
    }

    for (let i = 0; i < relevantFiles.length; i++) {
      for (let j = i + 1; j < relevantFiles.length; j++) {
        const fileA = relevantFiles[i];
        const fileB = relevantFiles[j];

        const key = fileA < fileB ? `${fileA}|${fileB}` : `${fileB}|${fileA}`;
        const [first, second] = key.split('|');

        if (!coChangeCounts.has(first)) {
          coChangeCounts.set(first, new Map());
        }
        coChangeCounts.get(first)!.set(
          second,
          (coChangeCounts.get(first)!.get(second) || 0) + 1
        );
      }
    }
  }

  const couplings: ChangeCoupling[] = [];

  for (const [fileA, partners] of coChangeCounts) {
    for (const [fileB, count] of partners) {
      if (count >= minCoChangeCount) {
        const totalA = fileCommitCounts.get(fileA) || 1;
        const totalB = fileCommitCounts.get(fileB) || 1;

        const strength = calculateCouplingStrength(count, totalA, totalB);

        couplings.push({
          fileA,
          fileB,
          strength,
          coChangeCount: count,
          totalCommitsA: totalA,
          totalCommitsB: totalB,
        });
      }
    }
  }

  couplings.sort((a, b) => b.strength - a.strength);

  const fileHistories = new Map<string, FileChangeHistory>();
  for (const [filePath, count] of fileCommitCounts) {
    fileHistories.set(filePath, {
      filePath,
      commitCount: count,
      lastModified: fileLastModified.get(filePath) || new Date(),
      authors: Array.from(fileAuthors.get(filePath) || []),
    });
  }

  const topCoupledFiles = new Map<string, string[]>();
  for (const coupling of couplings) {
    if (!topCoupledFiles.has(coupling.fileA)) {
      topCoupledFiles.set(coupling.fileA, []);
    }
    if (!topCoupledFiles.has(coupling.fileB)) {
      topCoupledFiles.set(coupling.fileB, []);
    }

    const listA = topCoupledFiles.get(coupling.fileA)!;
    if (listA.length < 5) listA.push(coupling.fileB);

    const listB = topCoupledFiles.get(coupling.fileB)!;
    if (listB.length < 5) listB.push(coupling.fileA);
  }

  return { couplings, fileHistories, topCoupledFiles };
}

function isGitRepo(repoPath: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

interface CommitInfo {
  hash: string;
  author: string;
  date: string;
}

function getCommitHistory(
  repoPath: string,
  maxCommits: number,
  since: string
): CommitInfo[] {
  try {
    const output = execSync(
      `git log --format="%H|%an|%aI" --since="${since}" -n ${maxCommits}`,
      {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    ).trim();

    if (!output) return [];

    return output.split('\n').map(line => {
      const [hash, author, date] = line.split('|');
      return { hash, author, date };
    });
  } catch {
    return [];
  }
}

function getCommitFiles(repoPath: string, commitHash: string): string[] {
  try {
    const output = execSync(`git diff-tree --no-commit-id --name-only -r ${commitHash}`, {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (!output) return [];

    return output.split('\n').filter(f => f.length > 0);
  } catch {
    return [];
  }
}

function calculateCouplingStrength(
  coChangeCount: number,
  totalA: number,
  totalB: number
): number {
  const minTotal = Math.min(totalA, totalB);
  if (minTotal === 0) return 0;

  const support = coChangeCount / minTotal;

  const confidence = coChangeCount / Math.sqrt(totalA * totalB);

  return (support + confidence) / 2;
}

export function getCoupledFiles(
  result: ChangeCouplingResult,
  filePath: string,
  minStrength: number = 0.3
): ChangeCoupling[] {
  return result.couplings.filter(
    c =>
      (c.fileA === filePath || c.fileB === filePath) && c.strength >= minStrength
  );
}

export function getChangePrediction(
  result: ChangeCouplingResult,
  changedFiles: string[],
  minStrength: number = 0.3
): Map<string, number> {
  const predictions = new Map<string, number>();

  for (const changedFile of changedFiles) {
    const couplings = getCoupledFiles(result, changedFile, minStrength);

    for (const coupling of couplings) {
      const otherFile = coupling.fileA === changedFile ? coupling.fileB : coupling.fileA;
      const current = predictions.get(otherFile) || 0;
      predictions.set(otherFile, Math.max(current, coupling.strength));
    }
  }

  return predictions;
}
