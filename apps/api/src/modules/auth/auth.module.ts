import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { APP_CONFIG, type AppConfig } from '../../infra/config/config';
import { AuthController, MeController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        secret: config.JWT_ACCESS_SECRET,
        signOptions: { algorithm: 'HS256', issuer: 'storeline', audience: 'storeline' },
        verifyOptions: { algorithms: ['HS256'], issuer: 'storeline', audience: 'storeline' },
      }),
    }),
  ],
  controllers: [AuthController, MeController],
  providers: [
    PasswordService,
    MfaService,
    SessionService,
    AuthService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [SessionService, PasswordService, MfaService],
})
export class AuthModule {}
