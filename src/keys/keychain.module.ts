import { Global, Module } from '@nestjs/common';
import { KeychainService } from './keychain.service';

/**
 * Provides the role-based {@link KeychainService} app-wide. Global so the Phase 1
 * cron services (auto-claim, vrf-reveal, partial-refund, close-terminal) and the
 * identity/SAS controller can inject it without re-importing the module.
 */
@Global()
@Module({
  providers: [KeychainService],
  exports: [KeychainService],
})
export class KeychainModule {}
