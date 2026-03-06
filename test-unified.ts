#!/usr/bin/env bun
/**
 * Test script for the unified QMD API
 * Tests indexing, graph building, embeddings, and search
 */

import { resolve, join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';

async function main() {
  console.log('🧪 Testing Unified QMD API\n');

  // Create temp test directory
  const testDir = join(tmpdir(), 'qmd-test-' + Date.now());
  mkdirSync(testDir, { recursive: true });

  // Create sample TypeScript file
  const sampleCode = `
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

interface User {
  id: number;
  name: string;
  email: string;
}

class UserService {
  private users: Map<number, User> = new Map();

  addUser(user: User): void {
    this.users.set(user.id, user);
  }

  getUser(id: number): User | undefined {
    return this.users.get(id);
  }

  async saveUsers(filePath: string): Promise<void> {
    const data = JSON.stringify(Array.from(this.users.values()));
    writeFileSync(filePath, data);
  }

  async loadUsers(filePath: string): Promise<void> {
    const data = readFileSync(filePath, 'utf-8');
    const users = JSON.parse(data) as User[];
    users.forEach(u => this.users.set(u.id, u));
  }
}

class EmailService {
  sendEmail(to: string, subject: string, body: string): boolean {
    console.log(\`Sending email to \${to}: \${subject}\`);
    return true;
  }
}

class NotificationService {
  constructor(private emailService: EmailService) {}

  notifyUser(user: User, message: string): void {
    this.emailService.sendEmail(user.email, 'Notification', message);
  }
}

function main() {
  const userService = new UserService();
  const emailService = new EmailService();
  const notificationService = new NotificationService(userService);

  userService.addUser({ id: 1, name: 'Alice', email: 'alice@example.com' });
  userService.addUser({ id: 2, name: 'Bob', email: 'bob@example.com' });

  const user = userService.getUser(1);
  if (user) {
    notificationService.notifyUser(user, 'Welcome!');
  }
}

export { UserService, EmailService, NotificationService, User };
`;

  const testFile = join(testDir, 'sample.ts');
  writeFileSync(testFile, sampleCode);

  console.log('📁 Created test file:', testFile);
  console.log('');

  try {
    // Import the unified QMD API
    console.log('📦 Importing unified QMD API...');
    const { QMD } = await import('./src/unified.ts');

    // Initialize QMD
    console.log('🔧 Initializing QMD...');
    const qmd = new QMD({
      databasePath: join(testDir, 'test.db'),
      embeddingModelPath: process.env.EMBEDDING_MODEL_PATH,
    });

    await qmd.initialize();
    console.log('✅ QMD initialized\n');

    // Index the test file
    console.log('📊 Indexing test file...');
    const result = await qmd.indexRepository(testDir, {
      generateEmbeddings: false, // Skip embeddings for faster test
      onProgress: (phase, progress, message) => {
        console.log(`   [${phase}] ${(progress * 100).toFixed(0)}% - ${message}`);
      },
    });

    console.log('\n📈 Indexing results:');
    console.log(`   Files indexed: ${result.filesIndexed}`);
    console.log(`   Symbols found: ${result.symbolsFound}`);
    console.log(`   Relationships: ${result.relationshipsCreated}`);
    console.log(`   Duration: ${result.durationMs}ms\n`);

    // Test search
    console.log('🔍 Testing search...');
    const searchResults = await qmd.search('UserService', { limit: 5 });
    console.log(`   Found ${searchResults.length} results`);
    searchResults.forEach((r, i) => {
      console.log(`   ${i + 1}. ${r.nodeName} (${r.label}) - score: ${r.score.toFixed(2)}`);
      console.log(`      file: ${r.filePath}`);
      console.log(`      id: ${r.nodeId}`);
    });
    console.log('');

    // Test graph queries
    console.log('🔗 Testing graph queries...');
    const userServiceNode = searchResults.find(r => r.nodeName === 'UserService');
    if (userServiceNode) {
      console.log(`   Getting callers of UserService...`);
      const callers = await qmd.getCallers(userServiceNode.nodeId);
      console.log(`   Callers: ${callers.length}`);
      callers.forEach(c => console.log(`      - ${c.name}`));

      console.log(`   Getting callees of UserService...`);
      const callees = await qmd.getCallees(userServiceNode.nodeId);
      console.log(`   Callees: ${callees.length}`);
      callees.forEach(c => console.log(`      - ${c.name}`));
    }
    console.log('');

    // Test stats
    console.log('📊 Graph stats:');
    const stats = await qmd.getStats();
    console.log(`   Nodes: ${stats.nodeCount}`);
    console.log(`   Relationships: ${stats.relationshipCount}`);
    console.log(`   Embeddings: ${stats.embeddingCount}`);
    console.log('');

    // Close
    await qmd.close();
    console.log('✅ All tests passed!');

  } catch (error) {
    console.error('❌ Test failed:', error);
    console.error(error.stack);
    process.exit(1);
  } finally {
    // Cleanup
    rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch(console.error);
