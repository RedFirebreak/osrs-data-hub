/**
 * A member's Discord avatar with initials as the fallback. Server- and client-safe (the avatar
 * primitives are client components).
 */
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

/**
 * "Zezima the Great" → "ZT"; one word → its first two letters. By code point, so an emoji in a
 * Discord name isn't cut in half. Used for every avatar of a user (header menu included).
 */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const chars = (word: string | undefined, n: number) =>
    Array.from(word ?? '')
      .slice(0, n)
      .join('');
  if (words.length === 1) return chars(words[0], 2).toUpperCase();
  return `${chars(words[0], 1)}${chars(words[1], 1)}`.toUpperCase();
}

export function UserAvatar({
  name,
  image,
  size = 'sm',
  className,
}: {
  name: string;
  image: string | null;
  size?: 'sm' | 'default' | 'lg';
  className?: string;
}) {
  return (
    <Avatar size={size} className={className}>
      {image && <AvatarImage src={image} alt="" />}
      <AvatarFallback>{initialsOf(name)}</AvatarFallback>
    </Avatar>
  );
}
