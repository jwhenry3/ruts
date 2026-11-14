import * as nest from "nest";

@Injectable()
export class LoggingInterceptor {
    intercept(c: Ptr<nest.Ctx>): Void {
        console.log(`[users] ${c.method} ${c.path}`);
    }
}
