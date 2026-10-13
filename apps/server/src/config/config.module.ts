import { Global, Inject, Module } from '@nestjs/common';
import { type Env, loadEnv } from './env';

export const ENV = Symbol('ENV');

/** Inject the validated environment: `constructor(@InjectEnv() private readonly env: Env)`. */
export const InjectEnv = (): ParameterDecorator => Inject(ENV);

@Global()
@Module({
  providers: [{ provide: ENV, useFactory: (): Env => loadEnv() }],
  exports: [ENV],
})
export class ConfigModule {}
